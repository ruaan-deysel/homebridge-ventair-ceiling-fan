import type { Logging } from 'homebridge';
import TuyAPI from 'tuyapi';
import type { DpValue } from '../dps.js';
import type { DpsListener, TuyaDevice } from './device.js';

export interface TuyapiOptions {
  id: string;
  key: string;
  version: string;
  ip?: string;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
/** Bounded so a write's confirming readback fails fast instead of hanging like refresh(). */
const READBACK_TIMEOUT_MS = 3_000;
/**
 * How long a write's readback keeps re-reading before giving up on the value appearing.
 *
 * `set()` is fire-and-forget (`shouldWaitForResponse: false`), so it resolves before the
 * fan has applied anything. Measured on real hardware: a single immediate readback gets
 * the datapoint's PREVIOUS value essentially every time — writing speed step 3 to a fan
 * sitting at 2 reads back 2, and the correct value arrives a few hundred milliseconds
 * later. Without this window every write on every fan was reported to HomeKit as a
 * SERVICE_COMMUNICATION_FAILURE even though it had actually landed.
 */
const WRITE_APPLY_MS = 2_000;
/** Gap between a write's readback attempts while waiting for the fan to apply it. */
const WRITE_POLL_MS = 200;
/**
 * How long, after a write's readback confirms, inbound echoes for that same datapoint
 * are held back from immediate delivery. The fan echoes its state as it works through
 * queued commands (see the class-level comment on `writeOnce`/`verifyWrite`), so a stale
 * echo carrying an OLDER value can still arrive just after our own confirmed write —
 * without this window it would land right after and overwrite the optimistic state
 * HomeKit already settled on. Anything that arrives during the window is not discarded,
 * though: it is buffered and reconciled with an authoritative read once the window ends
 * (see `armSettleTimer`/`resolveSettle`), so a genuine wall-switch/app change made right
 * after our write is still picked up — just after a short delay instead of instantly.
 */
const ECHO_SETTLE_MS = 1_500;

/** Distinguishes "the readback itself never came back" from any other rejection, so
 * `verifyWrite` knows when the underlying request is the kind tuyapi cannot cancel. */
class ReadbackTimeoutError extends Error {}

interface Waiter {
  /** Datapoints (from this caller's own patch) still attributed to it — shrinks as
   * later merged calls overwrite a key, and settles once the merged write actually runs. */
  keys: Set<string>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class TuyapiDevice implements TuyaDevice {
  private device: TuyAPI;
  private readonly dpsListeners: DpsListener[] = [];
  private readonly connectedListeners: (() => void)[] = [];
  private readonly disconnectedListeners: (() => void)[] = [];

  /** Non-null while a connect attempt is in flight — the guard against overlapping loops. */
  private inFlight: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private attempt = 0;

  /** True while a write is actually on the wire (a `runWrite` call is in progress). */
  private writing = false;
  /**
   * At most one queued merged patch, plus every caller currently waiting on it. A
   * further call while this is already populated is merged in: keys not present in the
   * new call are preserved from the queued patch, keys present in both take the new
   * call's value (last-write-wins per datapoint, not across the whole patch). See
   * `queueWrite`/`settleWaiters` for how each caller's own promise is settled against
   * what actually reaches the device, rather than against the merge itself.
   */
  private pendingWrite: { dps: Record<string, DpValue>; waiters: Waiter[] } | null = null;
  /** Waiters for the write currently on the wire — see `disconnect()`. */
  private activeWaiters: Waiter[] = [];

  /**
   * Per-datapoint deadline (ms, `Date.now()` scale) until which inbound echoes are
   * held back from immediate delivery — `Infinity` while a write to that dp is actually
   * in flight (set right before the wire send, replaced with a real deadline once the
   * readback confirms). A dp absent from this map has no pending write, so its echoes
   * always apply immediately — that's how a physical remote or the Smart Life app
   * reaches HomeKit.
   */
  private readonly echoSuppressedUntil = new Map<string, number>();
  /** Latest echoed value seen for a dp while it was suppressed, awaiting the
   * authoritative recheck `armSettleTimer` schedules once the window ends. */
  private readonly suppressedEcho = new Map<string, DpValue>();
  private readonly pendingSettleTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Bumped once per datapoint at the top of that datapoint's turn in `writeOnce`. A
   * read that started before the bump is, by definition, no longer describing the write
   * that owns the datapoint now — see `resolveSettle`, which captures this before its
   * `await` and discards the result if it changed while the read was in flight.
   */
  private readonly dpGeneration = new Map<string, number>();
  /**
   * Value a write genuinely confirmed but deliberately did NOT broadcast, because a
   * newer write for the same datapoint was already queued behind it (see `writeOnce`).
   * If that successor then fails, this is the last value the fan is actually known to
   * hold, so it is broadcast then instead of leaving the non-writing listener stale.
   * Cleared as soon as any value for the datapoint is broadcast.
   */
  private readonly unbroadcastConfirmed = new Map<string, DpValue>();
  /**
   * Datapoints with a write in flight, and the value that write expects the fan to
   * report back. `forwardDps` resolves one of these the moment the fan echoes a matching
   * value, which is how a write is confirmed — see `verifyWrite`.
   */
  private readonly pendingConfirm = new Map<string, { expected: DpValue; confirm: () => void }>();

  private readonly forwardDps = (data: unknown) => {
    const dps = (data as { dps?: Record<string, DpValue> } | undefined)?.dps;
    if (!dps) {
      return;
    }
    // Hold back delivery of any datapoint that has a write in flight or is still
    // within its post-readback settle window — see `echoSuppressedUntil`. Buffer the
    // held-back value rather than discarding it: `resolveSettle` reconciles it against
    // an authoritative read once the window ends, so it is delayed, not lost. A dp
    // with no pending write is untouched and applies immediately.
    const now = Date.now();
    const filtered: Record<string, DpValue> = {};
    for (const [dp, value] of Object.entries(dps)) {
      // The fan pushing the value we just wrote IS the confirmation that the write
      // landed — and it arrives promptly, unlike a readback (see `awaitEcho`). Consume
      // it here, before suppression, so the write can settle on it. Only an exact match
      // counts, so a stale echo carrying the OLD value can never confirm anything.
      const pending = this.pendingConfirm.get(dp);
      if (pending && value === pending.expected) {
        pending.confirm();
      }
      const until = this.echoSuppressedUntil.get(dp);
      if (until !== undefined && now < until) {
        this.suppressedEcho.set(dp, value);
        continue;
      }
      filtered[dp] = value;
    }
    if (Object.keys(filtered).length > 0) {
      this.emit(filtered);
    }
  };

  /**
   * Delivers to every listener, isolating each from the others. A throw from one used
   * to abort the loop (the rest never saw the update) and, on the write-confirmation
   * path, escaped into the write's own catch so a SUCCESSFUL write was reported as
   * failed and rolled back.
   */
  private emit(dps: Record<string, DpValue>): void {
    for (const listener of this.dpsListeners) {
      try {
        listener(dps);
      } catch (error) {
        this.log.debug(`[${this.opts.id}] dps listener threw:`, error instanceof Error ? error.message : error);
      }
    }
  }

  constructor(private readonly opts: TuyapiOptions, private readonly log: Logging) {
    this.device = this.createDevice();
    this.wireDevice();
  }

  private createDevice(): TuyAPI {
    return new TuyAPI({
      id: this.opts.id,
      key: this.opts.key,
      ip: this.opts.ip,
      version: this.opts.version,
      // Do NOT set issueRefreshOnConnect: tuyapi calls refresh() internally on
      // every connect when this is set, fire-and-forget, and refresh() was
      // measured to hang 20s against healthy hardware. The timeout then fires
      // 'error', which schedules a spurious reconnect on every healthy
      // connection. Initial state comes from the onConnected -> get({ schema: true })
      // path below instead.
    });
  }

  /** Wires the current `this.device` — called once at construction and again for every
   * fresh instance `recycleTransport` swaps in after a readback that never came back. */
  private wireDevice(): void {
    // Both events previously called connect() directly, which allowed two retry
    // loops to run concurrently. They now funnel through the same guarded path.
    this.device.on('disconnected', () => {
      this.connectedState = false;
      this.disconnectedListeners.forEach(l => l());
      this.scheduleReconnect('disconnected');
    });

    this.device.on('error', (error: Error) => {
      this.log.debug(`[${this.opts.id}] transport error: ${error.message}`);
      if (this.connectedState) {
        this.connectedState = false;
        this.disconnectedListeners.forEach(l => l());
      }
      this.scheduleReconnect('error');
    });

    this.device.on('connected', () => {
      this.connectedState = true;
      this.attempt = 0;
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      this.connectedListeners.forEach(l => l());
    });

    // tuyapi's own `Object` dp-value type is broader (allows nested objects/arrays)
    // than our `DpValue`; cast through `unknown` since hardware never sends those.
    this.device.on('data', this.forwardDps);
    this.device.on('dp-refresh', this.forwardDps);
  }

  /**
   * Tears down the current transport and swaps in a fresh one. tuyapi's installed
   * version (7.7.1) stores a resolver per outgoing sequence number in a private map
   * that is never cleared on timeout and has no public cancellation — a readback we
   * gave up on from our side is still "pending" forever inside the old instance, from
   * a fan that stays half-open (connected, but not replying). Repeated timeouts across
   * eight devices would otherwise grow that bookkeeping without bound. Discarding the
   * whole instance (its dead socket already destroyed via `disconnect()`) discards that
   * resolver too, instead of trying to reach into tuyapi's private state to cancel it.
   */
  private recycleTransport(): void {
    const stale = this.device;
    stale.disconnect();
    stale.removeAllListeners();
    this.pendingSettleTimers.forEach(t => clearTimeout(t));
    this.pendingSettleTimers.clear();
    this.device = this.createDevice();
    this.wireDevice();
    if (this.connectedState) {
      this.connectedState = false;
      this.disconnectedListeners.forEach(l => l());
    }
    this.scheduleReconnect('readback timeout');
  }

  private connectedState = false;

  get connected(): boolean {
    return this.connectedState;
  }

  /** Exposed for tests to assert backoff growth. */
  get nextDelayMs(): number {
    return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** this.attempt);
  }

  async connect(): Promise<void> {
    if (this.stopped || this.inFlight) {
      return this.inFlight ?? undefined;
    }
    this.inFlight = this.attemptConnect().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async attemptConnect(): Promise<void> {
    try {
      if (!this.opts.ip) {
        await this.device.find();
      }
      await this.device.connect();
      this.log.info(`[${this.opts.id}] connected`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const delay = jitter(this.nextDelayMs);
      this.attempt++;
      this.log.warn(`[${this.opts.id}] connect failed (${message}); retrying in ${Math.round(delay / 1000)}s`);
      this.armRetry(delay);
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.inFlight || this.retryTimer) {
      return;
    }
    this.log.debug(`[${this.opts.id}] scheduling reconnect (${reason})`);
    this.armRetry(jitter(this.nextDelayMs));
  }

  private armRetry(delay: number): void {
    if (this.stopped || this.retryTimer) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.pendingSettleTimers.forEach(t => clearTimeout(t));
    this.pendingSettleTimers.clear();
    this.connectedState = false;
    // Settle everything still waiting on a write, or those callers stay pending for the
    // life of the process — a HomeKit request that never returns either way. A promise
    // only settles once, so a waiter the normal completion path already resolved is
    // unaffected by this.
    const abandoned = [...this.activeWaiters, ...(this.pendingWrite?.waiters ?? [])];
    this.activeWaiters = [];
    this.pendingWrite = null;
    for (const waiter of abandoned) {
      waiter.reject(new Error(`[${this.opts.id}] write abandoned: device disconnected`));
    }
    this.device.disconnect();
  }

  /**
   * One `set()` call per datapoint, sequentially, each followed by a bounded readback
   * to confirm the device actually applied it.
   *
   * Measured on real Ventair Skyfan DC hardware: `set({ multiple: true, data })`
   * is accepted with no error but silently has NO EFFECT on this firmware — do
   * not "optimise" this back into a batched write. Sequential because there is
   * one TCP connection per device; concurrent writes on it are not worth the risk.
   *
   * `shouldWaitForResponse: false` (deliberate) means tuyapi's own `set()` promise
   * ALWAYS resolves, even when the underlying `_send()` fails — tuyapi only rejects
   * on a failed send when it's the one waiting for a reply (verified against
   * `node_modules/tuyapi/index.js` ~408-441: with `shouldWaitForResponse: false` the
   * executor calls `resolve()` synchronously and only *conditionally* rejects from
   * the `_send().catch()`, guarded by `options.shouldWaitForResponse`). So `set()`
   * resolving is NOT proof the datapoint reached the device — a socket lost after
   * the top-of-call connectivity guard, or a failure between two sequential
   * datapoints, both resolve as "success" with no readback. The connectivity guard
   * alone (checked once, only before the loop) cannot catch either case.
   *
   * The fix: after every datapoint write, re-check connectivity (a disconnect during
   * the previous datapoint must abort the rest of the patch — no partial writes
   * reported as full success) and read the datapoint back with `get({ dps })` —
   * never `refresh()`, which hangs 20s on this firmware, see the class-level
   * comment above. `get()` uses a different tuyapi request (DP_QUERY) than the
   * `_setQueue`-gated `set({ shouldWaitForResponse: true })` path, so it does not
   * risk the "A set command is already in progress" error that ruled out just
   * flipping `shouldWaitForResponse` to `true`.
   *
   * Latency tradeoff: this roughly doubles the round-trip cost of every write (one
   * send + one confirming read, per datapoint, times up to 8 fans sharing one
   * process) instead of the previous single fire-and-forget send. `READBACK_TIMEOUT_MS`
   * bounds the worst case tightly (3s) specifically so a device that goes dark
   * mid-write fails fast instead of hanging like `refresh()` does — pragmatic for
   * responsiveness, at the cost of every successful write now taking one extra
   * round trip.
   */
  /**
   * Coalesces rapid successive writes so the last value the user chose is the value that
   * actually reaches the fan, and tracks each caller's own datapoints through that merge
   * so nobody is told "done" before their data has actually reached (or is verified never
   * to reach) the hardware. tuyapi serialises `set()` calls through its own internal
   * queue, and each datapoint write is followed by a bounded readback (see `verifyWrite`)
   * — under a rapid burst (e.g. dragging the RotationSpeed slider: 20→40→60→80→100 with
   * no pause) an unbounded number of overlapping writes/readbacks would pile up behind
   * whichever one is currently on the wire, and the readback timeout then fails the
   * backed-up ones — which the caller's rollback then discards, silently dropping the
   * user's final chosen value even though nothing actually diverged.
   *
   * Fix: only one write is ever in flight, and at most one more is queued behind it. A
   * new call arriving while a write is queued is MERGED into the queued patch — keys
   * not present in the new call are preserved from the queued one, and keys present in
   * both are overwritten by the new call's value (last-write-wins per datapoint, not
   * across the whole patch). A caller queued behind the merge resolves immediately,
   * quietly, with no error, ONLY once every datapoint it originally asked for has been
   * overwritten by a later call (`queueWrite`) — its optimistic UI state for those keys
   * is about to be overwritten by the newer patch anyway. Any datapoint that survives
   * into the merge unaltered keeps its original caller waiting until that specific
   * datapoint is actually verified (`settleWaiters`), so a merged write that fails
   * partway rejects every caller still attributed to the datapoints that never landed —
   * not just the newest one.
   */
  async set(dps: Record<string, DpValue>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { keys: new Set(Object.keys(dps)), resolve, reject };
      if (this.writing) {
        this.queueWrite(dps, waiter);
        return;
      }
      this.writing = true;
      this.runWrite(dps, [waiter]);
    });
  }

  private queueWrite(dps: Record<string, DpValue>, waiter: Waiter): void {
    const current = this.pendingWrite;
    if (!current) {
      this.pendingWrite = { dps: { ...dps }, waiters: [waiter] };
      return;
    }
    const incomingKeys = Object.keys(dps);
    const retained: Waiter[] = [];
    for (const w of current.waiters) {
      incomingKeys.forEach(k => w.keys.delete(k));
      if (w.keys.size === 0) {
        // Every datapoint this waiter cared about was overwritten by a newer call
        // before ever reaching the wire — nothing it asked for will be sent under
        // its own value, so its promise settles now instead of waiting on a write
        // that no longer represents what it wrote.
        w.resolve();
      } else {
        retained.push(w);
      }
    }
    this.pendingWrite = {
      dps: { ...current.dps, ...dps },
      waiters: [...retained, waiter],
    };
  }

  private runWrite(dps: Record<string, DpValue>, waiters: Waiter[]): void {
    // Tracked so `disconnect()` can settle the write that is actually on the wire, not
    // just the one queued behind it.
    this.activeWaiters = waiters;
    this.writeOnce(dps)
      .then(({ confirmed, error }) => this.settleWaiters(waiters, confirmed, error))
      .finally(() => {
        if (this.activeWaiters === waiters) {
          this.activeWaiters = [];
        }
        const next = this.pendingWrite;
        this.pendingWrite = null;
        if (next) {
          this.runWrite(next.dps, next.waiters);
        } else {
          this.writing = false;
        }
      });
  }

  /** Settles every waiter against what `writeOnce` actually confirmed, not against
   * whether the merged write as a whole succeeded — a caller whose datapoints all
   * landed before an unrelated later one in the same patch failed must still resolve. */
  private settleWaiters(waiters: Waiter[], confirmed: Set<string>, error: unknown): void {
    for (const w of waiters) {
      const allLanded = [...w.keys].every(key => confirmed.has(key));
      if (allLanded) {
        w.resolve();
      } else {
        w.reject(error ?? new Error(`[${this.opts.id}] write failed`));
      }
    }
  }

  /**
   * The only way this class reads from the device. Every read is bounded — an unbounded
   * one against a half-open fan (connected, not replying) hangs whatever is awaiting it
   * forever, which for the failure-reconciliation path in `accessory.ts`
   * means an ambiguous optimistic state that is never resolved either way. A timeout also
   * recycles the transport, because tuyapi 7.7.1 leaves the abandoned request pending
   * inside it with no way to cancel — see `recycleTransport`.
   */
  /**
   * Reads ONE datapoint via a full-schema query rather than `get({ dps: n })`.
   *
   * Measured on real hardware: the single-datapoint query keeps returning the datapoint's
   * previous value for seconds after a write, while a full-schema query issued moments
   * later already reports the new one. Confirming writes against the single-datapoint
   * query therefore failed almost every write even though the fan had applied it.
   */
  private async readDp(dp: string): Promise<unknown> {
    const result = await this.boundedRead({ schema: true });
    if (result && typeof result === 'object' && 'dps' in result) {
      return (result as { dps: Record<string, DpValue> }).dps[dp];
    }
    return undefined;
  }

  private async boundedRead(query: { dps?: number; schema?: boolean }): Promise<unknown> {
    try {
      return await withTimeout(this.device.get(query) as Promise<unknown>, READBACK_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof ReadbackTimeoutError) {
        this.recycleTransport();
      }
      throw error;
    }
  }

  private async writeOnce(dps: Record<string, DpValue>): Promise<{ confirmed: Set<string>; error: unknown }> {
    const confirmed = new Set<string>();
    for (const [dp, value] of Object.entries(dps)) {
      if (!this.connectedState) {
        return { confirmed, error: new Error(`[${this.opts.id}] cannot write: device is disconnected`) };
      }
      // Suppress echoes for this dp for the whole in-flight duration, not just while
      // waiting for the readback — an echo racing in between the send and the
      // readback is just as stale as one arriving during the readback itself.
      this.echoSuppressedUntil.set(dp, Infinity);
      // This write now owns the datapoint: any read already in flight for it describes
      // a superseded write and must not be published (see `resolveSettle`).
      this.dpGeneration.set(dp, (this.dpGeneration.get(dp) ?? 0) + 1);
      const staleTimer = this.pendingSettleTimers.get(dp);
      if (staleTimer) {
        clearTimeout(staleTimer);
        this.pendingSettleTimers.delete(dp);
      }
      this.suppressedEcho.delete(dp);
      try {
        await this.device.set({ dps: Number(dp), set: value, shouldWaitForResponse: false });
        await this.verifyWrite(dp, value);
        confirmed.add(dp);
        this.echoSuppressedUntil.set(dp, Date.now() + ECHO_SETTLE_MS);
        // Publish the confirmed value to every listener now, rather than waiting on
        // an echo that suppression would hold back anyway, so every consumer of this
        // transport converges on the same state immediately after a write instead of
        // only the writer knowing about it. Skipped when a newer write for this dp is queued
        // behind this one: that queued write's own confirmation supersedes this value
        // shortly, and publishing this one first would flicker listeners through a
        // value already obsolete by the time they see it.
        if (this.pendingWrite?.dps[dp] === undefined) {
          this.unbroadcastConfirmed.delete(dp);
          this.emit({ [dp]: value });
        } else {
          this.unbroadcastConfirmed.set(dp, value);
        }
        this.armSettleTimer(dp);
      } catch (error) {
        // Outcome unknown — do not keep trusting our own state over the device's.
        this.echoSuppressedUntil.delete(dp);
        this.suppressedEcho.delete(dp);
        // Starting this write cleared its predecessor's settle timer and buffered echo,
        // so if the predecessor confirmed a value that was withheld only because THIS
        // write was queued behind it, nothing else would ever republish it. It is the
        // last value the fan is known to have applied — broadcast it now.
        const withheld = this.unbroadcastConfirmed.get(dp);
        if (withheld !== undefined) {
          this.unbroadcastConfirmed.delete(dp);
          this.emit({ [dp]: withheld });
        }
        return { confirmed, error };
      }
    }
    return { confirmed, error: undefined };
  }

  private armSettleTimer(dp: string, attempt = 0): void {
    const timer = setTimeout(() => {
      this.pendingSettleTimers.delete(dp);
      void this.resolveSettle(dp, attempt);
    }, ECHO_SETTLE_MS);
    timer.unref?.();
    this.pendingSettleTimers.set(dp, timer);
  }

  /**
   * Runs once a datapoint's settle window naturally elapses. If a genuine external
   * echo arrived and was buffered (held back) during the window — a wall switch or the
   * Smart Life app changing the datapoint while our own write was still settling — fetch
   * the authoritative current value and publish it to every listener. Without this, that
   * change would be lost forever unless the device happened to send another update later.
   * Skipped entirely when nothing happened during the window, so a quiet dp does not pay
   * for an extra read it doesn't need.
   */
  private async resolveSettle(dp: string, attempt = 0): Promise<void> {
    // Read the buffered marker WITHOUT consuming it: if the read below fails, the
    // external change it represents must still be pending, not silently discarded.
    if (!this.suppressedEcho.has(dp) || !this.connectedState) {
      return;
    }
    const generation = this.dpGeneration.get(dp);
    try {
      const actual = await this.readDp(dp);
      if (this.dpGeneration.get(dp) !== generation) {
        // A newer write for this dp started while the read was in flight and now owns
        // the datapoint; this result describes a superseded state. Discard it silently —
        // the newer write publishes its own confirmation.
        return;
      }
      this.suppressedEcho.delete(dp);
      this.unbroadcastConfirmed.delete(dp);
      this.emit({ [dp]: actual as DpValue });
    } catch (error) {
      this.log.debug(
        `[${this.opts.id}] authoritative recheck of dp ${dp} after echo suppression failed:`,
        error instanceof Error ? error.message : error,
      );
      // ponytail: exactly one retry. The buffered change deserves a second chance (a
      // readback timeout also recycles the transport, so the retry runs against a fresh
      // one), but retrying forever would poll a permanently sick device every 1.5s. If
      // the retry also fails, a reconnect's full `get()` refresh is the backstop.
      if (attempt === 0 && this.suppressedEcho.has(dp)) {
        this.armSettleTimer(dp, attempt + 1);
      }
    }
  }

  /**
   * Confirms a single datapoint write actually landed. Rejects on disconnect, or when
   * the fan neither echoed nor read back the value within `WRITE_APPLY_MS` — either of
   * which means the fan must not be treated as having received this datapoint.
   *
   * Two independent signals race, because measurement on real hardware showed neither is
   * sufficient alone:
   *
   * - The fan's own `data`/`dp-refresh` push (`awaitEcho`). This is the FAST and reliable
   *   one: the fan reports its new state within milliseconds of applying a change.
   * - A polled readback (`readDp`). Its per-datapoint form kept returning the previous
   *   value for many seconds after a write, and the full-schema form did too — spaced
   *   writes five seconds apart still read stale. Polling alone therefore failed
   *   essentially every write even though the fan had applied it correctly. It stays as a
   *   fallback for a fan that applies a value silently without pushing it.
   */
  private async verifyWrite(dp: string, expected: DpValue): Promise<void> {
    const deadline = Date.now() + WRITE_APPLY_MS;
    const echo = this.awaitEcho(dp, expected);
    try {
      let actual: unknown;
      for (;;) {
        if (!this.connectedState) {
          throw new Error(`[${this.opts.id}] write to dp ${dp} could not be confirmed: device disconnected`);
        }
        if (echo.settled()) {
          return;
        }
        try {
          actual = await this.readDp(dp);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`[${this.opts.id}] write to dp ${dp} could not be confirmed: ${message}`, { cause: error });
        }
        // The echo can land while the readback above is in flight, so re-check it here
        // rather than trusting a read that was already stale when it was issued.
        if (actual === expected || echo.settled()) {
          return;
        }
        if (Date.now() >= deadline) {
          throw new Error(`[${this.opts.id}] write to dp ${dp} was not applied (device reports ${JSON.stringify(actual)})`);
        }
        await Promise.race([sleep(WRITE_POLL_MS), echo.promise]);
      }
    } finally {
      echo.cancel();
    }
  }

  /** Resolves when the fan pushes `expected` for `dp` — see `forwardDps`. */
  private awaitEcho(dp: string, expected: DpValue): { promise: Promise<void>; settled: () => boolean; cancel: () => void } {
    let seen = false;
    let resolve!: () => void;
    const promise = new Promise<void>(r => {
      resolve = r;
    });
    const entry = {
      expected,
      confirm: () => {
        seen = true;
        resolve();
      },
    };
    this.pendingConfirm.set(dp, entry);
    return {
      promise,
      settled: () => seen,
      cancel: () => {
        // Only clear our own registration: a newer write for this dp may already have
        // replaced it, and clearing that would strand the newer write's confirmation.
        if (this.pendingConfirm.get(dp) === entry) {
          this.pendingConfirm.delete(dp);
        }
        resolve();
      },
    };
  }

  async get(): Promise<Record<string, DpValue>> {
    // Bounded like every other read: both failure-reconciliation paths call this while
    // already handling a rejected write, so the same unresponsive device that failed the
    // write must not be able to hang the reconciliation too.
    const result = await this.boundedRead({ schema: true });
    if (result && typeof result === 'object' && 'dps' in result) {
      return (result as { dps: Record<string, DpValue> }).dps;
    }
    return {};
  }

  onDps(l: DpsListener): () => void {
    this.dpsListeners.push(l);
    return () => {
      const i = this.dpsListeners.indexOf(l);
      if (i !== -1) {
        this.dpsListeners.splice(i, 1);
      }
    };
  }

  onConnected(l: () => void): void {
    this.connectedListeners.push(l);
  }

  onDisconnected(l: () => void): void {
    this.disconnectedListeners.push(l);
  }
}

/** Unref'd so a pending readback poll can never hold the process open. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms).unref?.();
  });
}

/** Spread retries so eight fans reconnecting after a network blip don't sync up. */
function jitter(delay: number): number {
  return delay * (0.5 + Math.random() / 2);
}

/** Rejects if `promise` doesn't settle within `ms` — never lets a readback hang. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ReadbackTimeoutError(`timed out after ${ms}ms`)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}
