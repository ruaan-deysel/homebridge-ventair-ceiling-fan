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
 * How long, after a write's readback confirms, inbound echoes for that same datapoint
 * keep being ignored. The fan echoes its state as it works through queued commands
 * (see the class-level comment on `writeOnce`/`verifyWrite`), so a stale echo carrying
 * an OLDER value can still arrive just after our own confirmed write — without this
 * window it would land right after and overwrite the optimistic state HomeKit already
 * settled on. Short enough that a genuine wall-switch/app change made right after our
 * write is still picked up quickly.
 */
const ECHO_SETTLE_MS = 1_500;

export class TuyapiDevice implements TuyaDevice {
  private readonly device: TuyAPI;
  private readonly dpsListeners: DpsListener[] = [];
  private readonly connectedListeners: (() => void)[] = [];
  private readonly disconnectedListeners: (() => void)[] = [];

  /** Non-null while a connect attempt is in flight — the guard against overlapping loops. */
  private inFlight: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private attempt = 0;

  /** True while a `writeOnce()` patch is actually on the wire. */
  private writing = false;
  /**
   * At most one queued patch: the newest `set()` call received while `writing` is true.
   * A further call while this is already populated supersedes it — the superseded
   * caller is resolved immediately (quietly, no error) since its optimistic state is
   * about to be overwritten by the newer patch anyway. Only ever the LAST value the
   * user chose is the one that actually reaches the device.
   */
  private pendingWrite: { dps: Record<string, DpValue>; resolve: () => void; reject: (error: unknown) => void } | null = null;

  /**
   * Per-datapoint deadline (ms, `Date.now()` scale) until which inbound echoes are
   * ignored — `Infinity` while a write to that dp is actually in flight (set right
   * before the wire send, cleared/expired once the readback confirms). A dp absent
   * from this map has no pending write, so its echoes always apply immediately —
   * that's how a physical remote or the Smart Life app reaches HomeKit.
   */
  private readonly echoSuppressedUntil = new Map<string, number>();

  constructor(private readonly opts: TuyapiOptions, private readonly log: Logging) {
    this.device = new TuyAPI({
      id: opts.id,
      key: opts.key,
      ip: opts.ip,
      version: opts.version,
      // Do NOT set issueRefreshOnConnect: tuyapi calls refresh() internally on
      // every connect when this is set, fire-and-forget, and refresh() was
      // measured to hang 20s against healthy hardware. The timeout then fires
      // 'error', which schedules a spurious reconnect on every healthy
      // connection. Initial state comes from the onConnected -> get({ schema: true })
      // path below instead.
    });

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
    const forward = (data: unknown) => {
      const dps = (data as { dps?: Record<string, DpValue> } | undefined)?.dps;
      if (!dps) {
        return;
      }
      // Drop stale echoes for any datapoint that has a write in flight or still
      // within its post-readback settle window — see `echoSuppressedUntil`. A dp
      // with no pending write is untouched and applies immediately.
      const now = Date.now();
      const filtered: Record<string, DpValue> = {};
      for (const [dp, value] of Object.entries(dps)) {
        const until = this.echoSuppressedUntil.get(dp);
        if (until !== undefined && now < until) {
          continue;
        }
        filtered[dp] = value;
      }
      if (Object.keys(filtered).length > 0) {
        this.dpsListeners.forEach(l => l(filtered));
      }
    };
    this.device.on('data', forward);
    this.device.on('dp-refresh', forward);
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
    this.connectedState = false;
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
   * actually reaches the fan. tuyapi serialises `set()` calls through its own internal
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
   * across the whole patch). The call it merged into is resolved immediately, quietly,
   * with no error — that caller's optimistic UI state for the keys it touched is about
   * to be overwritten by this newer patch anyway. The write that actually lands still
   * gets the full readback verification below; this only decides which patches get
   * sent, never whether a sent one is trusted.
   */
  async set(dps: Record<string, DpValue>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.writing) {
        this.pendingWrite?.resolve();
        const mergedDps = this.pendingWrite ? { ...this.pendingWrite.dps, ...dps } : dps;
        this.pendingWrite = { dps: mergedDps, resolve, reject };
        return;
      }
      this.writing = true;
      this.runWrite(dps, resolve, reject);
    });
  }

  private runWrite(dps: Record<string, DpValue>, resolve: () => void, reject: (error: unknown) => void): void {
    this.writeOnce(dps).then(resolve, reject).finally(() => {
      const next = this.pendingWrite;
      this.pendingWrite = null;
      if (next) {
        this.runWrite(next.dps, next.resolve, next.reject);
      } else {
        this.writing = false;
      }
    });
  }

  private async writeOnce(dps: Record<string, DpValue>): Promise<void> {
    for (const [dp, value] of Object.entries(dps)) {
      if (!this.connectedState) {
        throw new Error(`[${this.opts.id}] cannot write: device is disconnected`);
      }
      // Suppress echoes for this dp for the whole in-flight duration, not just while
      // waiting for the readback — an echo racing in between the send and the
      // readback is just as stale as one arriving during the readback itself.
      this.echoSuppressedUntil.set(dp, Infinity);
      try {
        await this.device.set({ dps: Number(dp), set: value, shouldWaitForResponse: false });
        await this.verifyWrite(dp, value);
        this.echoSuppressedUntil.set(dp, Date.now() + ECHO_SETTLE_MS);
      } catch (error) {
        // Outcome unknown — do not keep trusting our own state over the device's.
        this.echoSuppressedUntil.delete(dp);
        throw error;
      }
    }
  }

  /**
   * Bounded readback confirming a single datapoint write actually landed. Rejects on
   * disconnect, timeout, or a value mismatch — any of which means the fan must not be
   * treated as having received this datapoint.
   */
  private async verifyWrite(dp: string, expected: DpValue): Promise<void> {
    if (!this.connectedState) {
      throw new Error(`[${this.opts.id}] write to dp ${dp} could not be confirmed: device disconnected`);
    }
    let actual: unknown;
    try {
      actual = await withTimeout(
        this.device.get({ dps: Number(dp) }) as Promise<unknown>,
        READBACK_TIMEOUT_MS,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[${this.opts.id}] write to dp ${dp} could not be confirmed: ${message}`, { cause: error });
    }
    if (actual !== expected) {
      throw new Error(`[${this.opts.id}] write to dp ${dp} was not applied (device reports ${JSON.stringify(actual)})`);
    }
  }

  async get(): Promise<Record<string, DpValue>> {
    const result = await this.device.get({ schema: true });
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

/** Spread retries so eight fans reconnecting after a network blip don't sync up. */
function jitter(delay: number): number {
  return delay * (0.5 + Math.random() / 2);
}

/** Rejects if `promise` doesn't settle within `ms` — never lets a readback hang. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
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
