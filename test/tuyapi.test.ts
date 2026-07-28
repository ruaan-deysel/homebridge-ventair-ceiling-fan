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
  return { dps: {} };
});
const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};

vi.mock('tuyapi', () => ({
  default: class {
    connect = connect;
    find = find;
    disconnect = disconnect;
    refresh = refresh;
    isConnected = () => false;
    get = get;
    set = set;
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
    return { dps: {} };
  });
  Object.values(log).forEach(m => m.mockReset());
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

    // Device still reports the old value even though set() itself resolved —
    // exactly what a firmware quirk / lost datapoint looks like on the wire.
    get.mockImplementationOnce(async () => false);

    await expect(d.set({ '1': true })).rejects.toThrow(/was not applied/i);
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
