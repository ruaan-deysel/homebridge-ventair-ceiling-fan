import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connect = vi.fn();
const find = vi.fn();
const disconnect = vi.fn();
const refresh = vi.fn();
// Tracks the last value written per dp so the mocked `get()` readback below can echo
// it back — mirrors what real hardware does on a successful write, so tests that
// don't care about the readback confirmation don't have to fake it out individually.
const lastWrittenValue: Record<string, unknown> = {};
const set = vi.fn().mockImplementation(async (opts: { dps: number; set: unknown }) => {
  lastWrittenValue[String(opts.dps)] = opts.set;
  return { dps: {} };
});
const get = vi.fn().mockImplementation(async (opts?: { dps?: number; schema?: boolean }) => {
  if (opts?.dps !== undefined) {
    return lastWrittenValue[String(opts.dps)];
  }
  // Writes are confirmed with a full-schema read (see `readDp`): real hardware keeps
  // serving a STALE value from the single-datapoint query for seconds after a write,
  // while the schema query already reports the new one.
  return { dps: { ...lastWrittenValue } };
});
const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
// Counts how many underlying TuyAPI instances have been constructed — the regression
// guard for issue #4 (bounded transport recreation after a readback timeout) asserts
// against this rather than trying to inspect tuyapi's own private per-sequence
// resolver map, which isn't reachable through this mock (or the real library's public
// API either — that's the whole reason recreation is the fix).
const constructorSpy = vi.fn();
const removeAllListeners = vi.fn();

vi.mock('tuyapi', () => ({
  default: class {
    constructor() {
      constructorSpy();
    }
    connect = connect;
    find = find;
    disconnect = disconnect;
    refresh = refresh;
    isConnected = () => false;
    get = get;
    set = set;
    removeAllListeners = removeAllListeners;
    on(event: string, fn: (...a: unknown[]) => void) {
      (handlers[event] ??= []).push(fn);
      return this;
    }
  },
}));

const { TuyapiDevice } = await import('../src/tuya/tuyapi.js');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const opts = { id: 'abc123', key: 'x'.repeat(16), version: '3.3' as const };

function fire(event: string) {
  handlers[event]?.forEach(fn => fn(new Error('boom')));
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.keys(handlers).forEach(k => delete handlers[k]);
  connect.mockReset().mockResolvedValue(true);
  find.mockReset().mockResolvedValue(true);
  disconnect.mockReset();
  refresh.mockReset();
  Object.keys(lastWrittenValue).forEach(k => delete lastWrittenValue[k]);
  set.mockClear();
  set.mockImplementation(async (opts: { dps: number; set: unknown }) => {
    lastWrittenValue[String(opts.dps)] = opts.set;
    return { dps: {} };
  });
  get.mockClear();
  get.mockImplementation(async (opts?: { dps?: number; schema?: boolean }) => {
    if (opts?.dps !== undefined) {
      return lastWrittenValue[String(opts.dps)];
    }
    return { dps: { ...lastWrittenValue } };
  });
  Object.values(log).forEach(m => m.mockReset());
  constructorSpy.mockClear();
  removeAllListeners.mockClear();
});

afterEach(() => vi.useRealTimers());

describe('reconnect supervision', () => {
  it('collapses simultaneous error and disconnected into one attempt', async () => {
    const d = new TuyapiDevice(opts, log);
    connect.mockImplementation(() => new Promise(() => {})); // never settles
    d.connect();
    fire('error');
    fire('disconnected');
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially and caps at 60s', async () => {
    const d = new TuyapiDevice(opts, log);
    connect.mockRejectedValue(new Error('refused'));
    d.connect();
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(d.nextDelayMs).toBeLessThanOrEqual(60_000);
    expect(connect.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops retrying after disconnect', async () => {
    const d = new TuyapiDevice(opts, log);
    connect.mockRejectedValue(new Error('refused'));
    d.connect();
    await vi.advanceTimersByTimeAsync(2000);
    const before = connect.mock.calls.length;
    d.disconnect();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connect.mock.calls.length).toBe(before);
  });

  it('never logs the key', async () => {
    const d = new TuyapiDevice(opts, log);
    connect.mockRejectedValue(new Error('refused'));
    d.connect();
    await vi.advanceTimersByTimeAsync(5000);
    const all = JSON.stringify(Object.values(log).map(m => m.mock.calls));
    expect(all).not.toContain(opts.key);
  });

  it('never calls refresh() — it hangs 20s against real hardware', async () => {
    const d = new TuyapiDevice(opts, log);
    d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('first retry delay is ~1s, not 2s', async () => {
    // Asserts the ACTUAL scheduled timer delay (via a setTimeout spy), not `nextDelayMs`
    // read back after the attempt counter has already incremented — that indirect check
    // can't tell apart "delay computed before incrementing attempt" (correct) from
    // "delay computed after" (a real bug: it would double every scheduled delay while
    // `nextDelayMs` afterwards still reads the same either way).
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const d = new TuyapiDevice(opts, log);
    connect.mockRejectedValue(new Error('refused'));
    d.connect();
    await vi.advanceTimersByTimeAsync(0);

    const scheduledDelays = setTimeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === 'number' && delay > 0);
    expect(scheduledDelays.length).toBeGreaterThan(0);
    const armedDelay = scheduledDelays[scheduledDelays.length - 1];
    // jitter(1s) = 1000 * (0.5 + rand/2) => [500, 1000]. A buggy 2s delay would fall
    // in [1000, 2000] instead — outside this range except at the single boundary point.
    expect(armedDelay).toBeGreaterThanOrEqual(500);
    expect(armedDelay).toBeLessThan(1000);
  });

  it('marks disconnected and notifies listeners on a transport error, not just on the disconnected event', async () => {
    const d = new TuyapiDevice(opts, log);
    const disconnected = vi.fn();
    d.onDisconnected(disconnected);
    connect.mockImplementation(() => new Promise(() => {})); // never settles
    d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');
    expect(d.connected).toBe(true);

    fire('error');
    expect(d.connected).toBe(false);
    expect(disconnected).toHaveBeenCalledTimes(1);

    // A second error while already disconnected must not double-notify.
    fire('error');
    expect(disconnected).toHaveBeenCalledTimes(1);
  });

  it('clears a pending retry timer on a successful reconnect so a stale retry cannot fire', async () => {
    const d = new TuyapiDevice(opts, log);
    connect.mockRejectedValueOnce(new Error('refused'));
    d.connect();
    await vi.advanceTimersByTimeAsync(0); // first attempt fails and arms a retry timer

    fire('connected'); // reconnect succeeds via some other path

    // If the stale retry timer were not cleared it would fire connect() again here.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('sends one set() call per datapoint, not a batched write', async () => {
    // This firmware silently ignores multiple:true batched writes on real
    // hardware — see the comment on TuyapiDevice.set(). One call per dp is
    // the regression guard for that.
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');
    await d.set({ '1': true, '3': 5 });
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenNthCalledWith(1, { dps: 1, set: true, shouldWaitForResponse: false });
    expect(set).toHaveBeenNthCalledWith(2, { dps: 3, set: 5, shouldWaitForResponse: false });
  });

  it('rejects a write attempted while disconnected instead of silently swallowing it', async () => {
    // tuyapi's set() always resolves with shouldWaitForResponse: false (it only
    // rejects on send failure when it's waiting for a reply) — so without this
    // guard a write issued while offline would resolve as if it succeeded,
    // leaving HomeKit/Matter believing a command reached hardware that never
    // saw it. See the comment on TuyapiDevice.set().
    const d = new TuyapiDevice(opts, log);
    expect(d.connected).toBe(false);
    await expect(d.set({ '1': true })).rejects.toThrow(/disconnected/i);
    expect(set).not.toHaveBeenCalled();
  });

  it('rejects the whole patch when the device disconnects between two datapoints', async () => {
    // The connectivity guard used to run once, before the loop — a disconnect that
    // happened *between* two sequential datapoint writes (now genuinely possible:
    // writes are sequential single-DP calls) sailed straight through undetected, and
    // the second datapoint was sent over a connection that was already gone.
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    set.mockImplementationOnce(async (o: { dps: number; set: unknown }) => {
      lastWrittenValue[String(o.dps)] = o.set;
      // Socket dies right after the first datapoint's send completes, before the
      // second datapoint is ever attempted.
      fire('disconnected');
      return { dps: {} };
    });

    await expect(d.set({ '1': true, '3': 5 })).rejects.toThrow(/disconnected/i);
    // The second datapoint must never have been sent over the dead connection.
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('rejects a write when the confirming readback cannot be completed', async () => {
    // set() with shouldWaitForResponse: false always resolves regardless of whether
    // the datapoint actually reached the device. Without a readback, a send failure
    // between the guard and the wire (e.g. the socket dying mid-send) resolved as
    // success. This is the regression guard for the readback itself existing at all.
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    get.mockImplementationOnce(async () => {
      throw new Error('read failed');
    });

    await expect(d.set({ '1': true })).rejects.toThrow(/could not be confirmed/i);
  });

  it('rejects a write the device silently ignored (readback reports a different value)', async () => {
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    // Device KEEPS reporting the old value for the whole apply window, not just for the
    // first readback — exactly what a firmware quirk / lost datapoint looks like on the
    // wire, and what distinguishes it from the fan merely being slow to apply the value.
    get.mockImplementation(async () => false);

    const rejects = expect(d.set({ '1': true })).rejects.toThrow(/was not applied/i);
    await vi.advanceTimersByTimeAsync(3_000);
    await rejects;
  });

  it('confirms a write from the fan echoing the value, even while every readback stays stale', async () => {
    // Measured on real hardware: after writing speed step 3 to a fan sitting at 2, BOTH
    // the per-datapoint and the full-schema readback keep reporting 2 — spaced writes
    // five seconds apart still read stale — while the fan's own data push carries 3
    // within milliseconds. Confirming from readbacks alone failed essentially every
    // write despite the fan having applied it.
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    get.mockImplementation(async () => ({ dps: { '3': 2 } })); // never catches up

    const write = d.set({ '3': 3 });
    await vi.advanceTimersByTimeAsync(50);
    handlers['data']?.[0]?.({ dps: { '3': 3 } }); // the fan reports what it applied

    await vi.advanceTimersByTimeAsync(50);
    await expect(write).resolves.toBeUndefined();
  });

  it('does not let a stale echo carrying the OLD value confirm a write', async () => {
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    get.mockImplementation(async () => ({ dps: { '3': 2 } }));

    const write = d.set({ '3': 3 });
    const assertion = expect(write).rejects.toThrow(/was not applied/i);
    await vi.advanceTimersByTimeAsync(50);
    handlers['data']?.[0]?.({ dps: { '3': 2 } }); // the PREVIOUS value, not ours
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
  });

  it('waits for a slow fan to apply a write instead of failing it on the first stale readback', async () => {
    // Real hardware, measured on the bridge: set() is fire-and-forget, so the first
    // readback after writing speed step 3 to a fan sitting at 2 returns 2 — the value
    // only appears a few hundred ms later. Treating that first stale read as a failure
    // reported EVERY write to HomeKit as SERVICE_COMMUNICATION_FAILURE despite the fan
    // having applied it correctly.
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    let reads = 0;
    get.mockImplementation(async () => {
      reads++;
      return { dps: { '3': reads <= 2 ? 2 : 3 } }; // stale twice, then the write lands
    });

    const write = d.set({ '3': 3 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(write).resolves.toBeUndefined();
    expect(reads).toBeGreaterThan(1);
  });

  it('coalesces rapid successive writes: only the last value reaches the transport, and superseded writes drop quietly', async () => {
    // Reproduces dragging the RotationSpeed slider (20→40→60→80→100 with no pause):
    // each set() call is issued before the previous one's set+readback round trip has
    // settled. Without coalescing, the backed-up writes' readbacks race and the
    // caller's rollback then discards the user's actual final choice.
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    const first = d.set({ '3': 2 }); // starts immediately — becomes "in flight"
    const second = d.set({ '3': 3 }); // queued, then superseded before it ever sends
    const third = d.set({ '3': 5 }); // supersedes `second`; the value that must land

    // Superseded and in-flight writes both resolve quietly — no rejection, no
    // unhandled rejection, nothing for the accessory's rollback path to react to.
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    await expect(third).resolves.toBeUndefined();

    const valuesSent = set.mock.calls.map(([call]) => (call as { set: unknown }).set);
    expect(valuesSent).not.toContain(3); // the superseded middle value never hit the wire
    expect(valuesSent[valuesSent.length - 1]).toBe(5);
    // The device's actual last state — and its verified readback — is the user's
    // final chosen value, not whatever happened to be in flight when the burst started.
    expect(lastWrittenValue['3']).toBe(5);
  });

  it('merges a queued write with an unrelated incoming write instead of discarding it wholesale', async () => {
    // Reproduces: change fan speed then immediately flip direction before the speed
    // write drains. Both must reach the transport — direction must not erase speed.
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    const first = d.set({ '1': true }); // starts immediately — becomes "in flight"
    const second = d.set({ '1': true, '3': 5 }); // queued: power + speed
    const third = d.set({ '8': 'reverse' }); // arrives before the queued patch drains

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    await expect(third).resolves.toBeUndefined();

    // All three datapoints must have reached the transport — none silently dropped.
    expect(lastWrittenValue['1']).toBe(true);
    expect(lastWrittenValue['3']).toBe(5);
    expect(lastWrittenValue['8']).toBe('reverse');
  });

  it('applies per-key last-write-wins on a queued write, keeping only the newest value for a duplicated key', async () => {
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    const first = d.set({ '1': true }); // in flight, unrelated to dp 3
    const second = d.set({ '3': 5 }); // queued
    const third = d.set({ '3': 2 }); // supersedes dp 3 in the queued patch

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    await expect(third).resolves.toBeUndefined();

    const dp3Values = set.mock.calls.filter(([call]) => (call as { dps: number }).dps === 3)
      .map(([call]) => (call as { set: unknown }).set);
    expect(dp3Values).toEqual([2]); // only the final value for dp 3 was ever sent
  });

  it('ignores stale echoes for a datapoint while our own write is in flight or settling, and applies the last COMMAND, not the last echo', async () => {
    // Reproduces the live bug: dragging RotationSpeed 20->40->60->80->100 makes the
    // fan echo back speedStep values as it works through queued commands, and an
    // echo carrying an OLDER value can land after our newer write and overwrite the
    // optimistic state. HomeKit must end up at the LAST COMMAND (5), never at
    // whatever stale echo happens to arrive.
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    const received: Record<string, unknown>[] = [];
    d.onDps(dps => received.push(dps));

    const first = d.set({ '3': 2 }); // in flight
    const second = d.set({ '3': 3 }); // queued, then superseded
    const third = d.set({ '3': 5 }); // the user's actual final choice

    // Stale echoes of superseded/older values racing in while writes are in flight
    // or freshly settled must be dropped.
    handlers['data']?.[0]?.({ dps: { '3': 1 } });
    handlers['data']?.[0]?.({ dps: { '3': 2 } });
    handlers['data']?.[0]?.({ dps: { '3': 3 } });

    await Promise.all([first, second, third]);

    handlers['data']?.[0]?.({ dps: { '3': 2 } }); // still stale, still within settle window

    const speedUpdates = received.filter(p => '3' in p).map(p => p['3']);
    expect(speedUpdates).not.toContain(1);
    expect(speedUpdates).not.toContain(2);
    expect(speedUpdates).not.toContain(3);
    expect(lastWrittenValue['3']).toBe(5);

    // fails if reverted: without suppression every stale echo above lands in
    // `received`, and the last one ('3': 2) would be what HomeKit is left showing.
  });

  it('applies an echo immediately for a datapoint with no pending write (physical remote / Smart Life app change)', async () => {
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    const received: Record<string, unknown>[] = [];
    d.onDps(dps => received.push(dps));

    // Nothing has ever written dp '1' — a wall switch or the Smart Life app flips
    // it. This must reach HomeKit right away, not be held back.
    handlers['data']?.[0]?.({ dps: { '1': false } });

    expect(received).toEqual([{ '1': false }]);
  });

  it('resumes accepting echoes for a datapoint once its settle window has elapsed', async () => {
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    const received: Record<string, unknown>[] = [];
    d.onDps(dps => received.push(dps));

    await d.set({ '3': 5 });
    // The confirmed write itself is published immediately — see the dedicated
    // HAP/Matter convergence test below. Not the focus here; clear it out.
    expect(received).toEqual([{ '3': 5 }]);
    received.length = 0;

    // Once the settle window has fully elapsed with no activity during it, a genuine
    // subsequent change (e.g. someone at the wall control nudging the speed) applies
    // normally, with no extra device read.
    await vi.advanceTimersByTimeAsync(1_501);
    get.mockClear();
    handlers['data']?.[0]?.({ dps: { '3': 4 } });
    expect(received).toEqual([{ '3': 4 }]);
    expect(get).not.toHaveBeenCalled();
  });

  it('publishes a confirmed write to every listener immediately, so HAP and Matter converge without waiting on a suppressed echo', async () => {
    // Two independent consumers (HAP's CeilingFanAccessory and MatterFanBridge) both
    // subscribe via onDps on the same shared transport. Before this fix, a write's own
    // confirming readback was never published — it only ever reached listeners as an
    // echo, and that echo was suppressed by the very write that produced it. So the
    // consumer that did NOT issue the write never learned the new state at all.
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    const hapSeen: Record<string, unknown>[] = [];
    const matterSeen: Record<string, unknown>[] = [];
    d.onDps(dps => hapSeen.push(dps));
    d.onDps(dps => matterSeen.push(dps));

    // Simulates HAP issuing the write; Matter never calls set() itself.
    await d.set({ '3': 4 });

    expect(hapSeen).toEqual([{ '3': 4 }]);
    expect(matterSeen).toEqual([{ '3': 4 }]);
    // fails if reverted: without the immediate broadcast, both arrays stay empty —
    // the confirming readback is filtered out by echo suppression before either
    // listener ever sees it.
  });

  it('reconciles an external change that arrived during the suppression window with an authoritative read, instead of losing it', async () => {
    // Reproduces: someone flips the wall switch (or the Smart Life app) right after
    // this process wrote a different datapoint, while that write's echo-suppression
    // window is still open. Before this fix the echo was dropped outright and, unless
    // the device happened to send another update later, the change never reached
    // HomeKit at all.
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    const received: Record<string, unknown>[] = [];
    d.onDps(dps => received.push(dps));

    await d.set({ '3': 5 });
    received.length = 0; // drop the immediate confirmed-write broadcast; not the focus here

    // A wall-switch change to a DIFFERENT value arrives mid-window — held back, not
    // delivered yet.
    handlers['data']?.[0]?.({ dps: { '3': 2 } });
    expect(received).toHaveLength(0);

    // The device's true current value (as a real authoritative read would report) is
    // the wall-switch change, not our own written value.
    get.mockImplementationOnce(async () => ({ dps: { '3': 2 } }));

    await vi.advanceTimersByTimeAsync(1_501);

    expect(received).toEqual([{ '3': 2 }]);
    // fails if reverted: without buffering + a post-window authoritative recheck, the
    // wall-switch change above is discarded and `received` stays empty forever.
  });

  it('settles every waiter for a merged write by which of its own datapoints actually landed, not by arrival order', async () => {
    // Reproduces: a queued speed change is merged behind an in-flight write, then an
    // unrelated direction change arrives and is merged in too. Before this fix, the
    // speed-change caller was resolved the instant the direction change merged in —
    // before ANY of the merged patch had reached the device. If the merged write then
    // failed, only the newest caller (direction) rejected; the speed caller stayed
    // falsely "committed" even though its datapoint never landed.
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    const first = d.set({ '1': true }); // real write, currently in flight
    const speedChange = d.set({ '3': 5 }); // queued behind it
    const directionChange = d.set({ '8': 'reverse' }); // merges in alongside speedChange, doesn't touch dp 3

    // The merged write (dp 3 then dp 8, in that order) fails on its first datapoint.
    // dp 1 — the separate, already in-flight write — was called synchronously above,
    // before this override takes effect, so it still succeeds normally.
    let mergedAttempted = false;
    set.mockImplementation(async (o: { dps: number; set: unknown }) => {
      if (!mergedAttempted && o.dps === 3) {
        mergedAttempted = true;
        throw new Error('device unreachable');
      }
      lastWrittenValue[String(o.dps)] = o.set;
      return { dps: {} };
    });

    await expect(first).resolves.toBeUndefined();
    // Neither datapoint in the merged patch ever reached the device — both callers
    // that were still attributed to it at the time it ran must reject, not just the
    // newest one.
    await expect(speedChange).rejects.toThrow(/unreachable/i);
    await expect(directionChange).rejects.toThrow(/unreachable/i);
    // fails if reverted: without per-datapoint waiter settlement, `speedChange` above
    // resolves successfully the moment `directionChange` merges in, regardless of what
    // the merged write actually does.
  });

  it('keeps outstanding transport requests bounded across repeated readback timeouts', async () => {
    // Installed tuyapi (7.7.1) stores a resolver per outgoing sequence number that is
    // never cleared on our side's timeout and exposes no cancellation — a half-open
    // fan (still "connected", but no longer replying) leaves one of these behind per
    // timed-out write. The fix recreates the whole transport instance after a readback
    // timeout, discarding that stuck resolver along with it, so repeated automations
    // across eight devices don't grow this bookkeeping without bound.
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    const instancesAtStart = constructorSpy.mock.calls.length;
    const disconnected = vi.fn();
    d.onDisconnected(disconnected);

    // Simulates a half-open connection: the readback's get() never settles.
    get.mockImplementation(() => new Promise(() => {}));

    for (let i = 0; i < 3; i++) {
      const write = d.set({ '1': true });
      // Attach the rejection assertion before advancing timers — otherwise the
      // rejection (which fires mid-advance) briefly has no handler attached yet,
      // which vitest/Node flags as an unhandled rejection even though it's
      // immediately awaited below.
      const assertion = expect(write).rejects.toThrow(/could not be confirmed/i);
      await vi.advanceTimersByTimeAsync(3_100); // past READBACK_TIMEOUT_MS
      await assertion;
      expect(d.connected).toBe(false);
      fire('connected'); // simulates the automatic reconnect tuyapi performs
    }

    // One brand-new underlying transport per timeout — never one growing instance
    // that keeps accumulating stuck resolvers.
    expect(constructorSpy.mock.calls.length).toBe(instancesAtStart + 3);
    expect(disconnect).toHaveBeenCalledTimes(3);
    expect(disconnected).toHaveBeenCalledTimes(3);
    // fails if reverted: without recreation, constructorSpy stays at instancesAtStart
    // (the same TuyAPI instance, and its stuck resolvers, is reused across all three
    // timeouts) and `d.connected` never flips false on a timeout at all.
  });

  it('keeps a buffered external change pending (and recycles the transport) when the settle recheck times out', async () => {
    // A wall-switch change arrives during a write's settle window and is buffered. The
    // authoritative recheck that should publish it then times out against a half-open
    // fan. The buffered change must survive that failure — it is the only record that
    // something happened — and the timed-out read must recycle the transport just like
    // any other readback timeout does.
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    const received: Record<string, unknown>[] = [];
    d.onDps(dps => received.push(dps));

    await d.set({ '3': 5 });
    received.length = 0; // drop the confirmed-write broadcast; not the focus here

    handlers['data']?.[0]?.({ dps: { '3': 2 } }); // buffered, held back
    expect(received).toHaveLength(0);

    const instancesAtStart = constructorSpy.mock.calls.length;
    get.mockImplementation(() => new Promise(() => {})); // recheck never comes back
    await vi.advanceTimersByTimeAsync(1_501); // settle window elapses, recheck starts
    await vi.advanceTimersByTimeAsync(3_100); // past READBACK_TIMEOUT_MS

    expect(constructorSpy.mock.calls.length).toBe(instancesAtStart + 1);
    expect(d.connected).toBe(false);
    expect(received).toHaveLength(0);

    // The buffered change is still pending, so once the device is reachable again the
    // retry publishes it rather than dropping it on the floor.
    fire('connected');
    get.mockImplementation(async () => ({ dps: { '3': 2 } }));
    await vi.advanceTimersByTimeAsync(1_501);

    expect(received).toEqual([{ '3': 2 }]);
    // fails if reverted: the marker is consumed before the read, so nothing survives the
    // timeout, the transport is never recycled, and `received` stays empty.
  });

  it('discards a settle recheck whose datapoint was claimed by a newer write while the read was in flight', async () => {
    // The settle recheck reads dp 3, and before that read returns the user issues a new
    // speed command for the same datapoint. The read's result now describes a superseded
    // state; publishing it would overwrite the newer write's confirmation with an older
    // value.
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    const received: Record<string, unknown>[] = [];
    d.onDps(dps => received.push(dps));

    await d.set({ '3': 5 });
    handlers['data']?.[0]?.({ dps: { '3': 2 } }); // buffered → a recheck will be issued

    let releaseRecheck!: (value: unknown) => void;
    get.mockImplementationOnce(() => new Promise(resolve => {
      releaseRecheck = resolve;
    }));
    await vi.advanceTimersByTimeAsync(1_501); // recheck starts and hangs

    await d.set({ '3': 4 }); // newer write claims dp 3 while the recheck is outstanding
    releaseRecheck(2); // the stale recheck finally answers with the superseded value
    await vi.advanceTimersByTimeAsync(0);

    const speeds = received.filter(p => '3' in p).map(p => p['3']);
    expect(speeds).toEqual([5, 4]);
    expect(speeds).not.toContain(2);
    // fails if reverted: the ungated recheck publishes { '3': 2 } after the newer
    // write's confirmation, leaving every listener showing the superseded value.
  });

  it('rejects the public get() within the readback timeout instead of hanging on a half-open device', async () => {
    // Both failure-reconciliation paths (accessory.ts / matter.ts) call get() while
    // already handling a rejected write. Unbounded, the same unresponsive device that
    // failed the write leaves the reconciliation pending forever.
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    const instancesAtStart = constructorSpy.mock.calls.length;
    get.mockImplementation(() => new Promise(() => {}));

    const pending = d.get();
    const assertion = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(3_100);
    await assertion;

    expect(constructorSpy.mock.calls.length).toBe(instancesAtStart + 1);
    // fails if reverted: `pending` never settles, so the assertion above times out.
  });

  it('broadcasts a confirmed value that was withheld for a queued successor when that successor fails', async () => {
    // The in-flight write confirms dp 3 = 5, but its broadcast is deliberately skipped
    // because a newer write for dp 3 is already queued behind it. If that successor then
    // fails, 5 is the last value the fan is known to hold — and starting the successor
    // already cleared the settle timer and buffered echo, so nothing else would ever
    // publish it. The listener that did not issue the write must not stay stale.
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    const hapSeen: Record<string, unknown>[] = [];
    const matterSeen: Record<string, unknown>[] = [];
    d.onDps(dps => hapSeen.push(dps));
    d.onDps(dps => matterSeen.push(dps));

    const first = d.set({ '3': 5 }); // in flight; confirms, but its broadcast is withheld
    const second = d.set({ '3': 2 }); // queued successor, which then fails on the wire
    set.mockImplementation(async () => {
      throw new Error('device unreachable');
    });

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow(/unreachable/i);

    expect(hapSeen).toEqual([{ '3': 5 }]);
    expect(matterSeen).toEqual([{ '3': 5 }]);
    // fails if reverted: both arrays stay empty — the confirmed value is withheld for a
    // successor that never lands, and nothing republishes it.
  });

  it('survives a throwing dps listener: the write still succeeds and the other listener still gets the value', async () => {
    // HAP and Matter both subscribe to the same transport. A direct forEach over the
    // listeners let one consumer's throw abort the loop AND escape into the write's own
    // catch, turning a successful write into a reported failure.
    const d = new TuyapiDevice(opts, log);
    await d.connect();
    await vi.advanceTimersByTimeAsync(0);
    fire('connected');

    const healthySeen: Record<string, unknown>[] = [];
    d.onDps(() => {
      throw new Error('listener exploded');
    });
    d.onDps(dps => healthySeen.push(dps));

    await expect(d.set({ '3': 4 })).resolves.toBeUndefined();
    expect(healthySeen).toEqual([{ '3': 4 }]);

    // The same isolation applies to a plain inbound echo for an unwritten datapoint.
    await vi.advanceTimersByTimeAsync(1_501);
    handlers['data']?.[0]?.({ dps: { '1': true } });
    expect(healthySeen).toEqual([{ '3': 4 }, { '1': true }]);
    // fails if reverted: the first listener's throw aborts the loop, so `healthySeen`
    // stays empty and d.set() rejects instead of resolving.
  });

  it('onDps returns a disposer that detaches the listener', async () => {
    // Nothing replaces an accessory/bridge on a live transport today (discovery runs
    // once), but a subscriber that IS replaced in the future must be able to detach —
    // otherwise re-running setup stacks listeners on the same transport forever.
    const d = new TuyapiDevice(opts, log);
    const received: unknown[] = [];
    const off = d.onDps(dps => received.push(dps));

    const forward = handlers['data']?.[0];
    forward?.({ dps: { '1': true } });
    expect(received).toHaveLength(1);

    off();
    forward?.({ dps: { '1': false } });
    expect(received).toHaveLength(1); // no further deliveries after detaching
  });
});
