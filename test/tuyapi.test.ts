import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connect = vi.fn();
const find = vi.fn();
const disconnect = vi.fn();
const refresh = vi.fn();
const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};

vi.mock('tuyapi', () => ({
  default: class {
    connect = connect;
    find = find;
    disconnect = disconnect;
    refresh = refresh;
    isConnected = () => false;
    get = vi.fn().mockResolvedValue({ dps: {} });
    set = vi.fn().mockResolvedValue({ dps: {} });
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
    const d = new TuyapiDevice(opts, log);
    connect.mockRejectedValue(new Error('refused'));
    d.connect();
    await vi.advanceTimersByTimeAsync(0);
    // jitter is 50-100% of nextDelayMs; after the first failure nextDelayMs is 2s
    // (attempt incremented to 1), so the delay just scheduled was jitter(1s).
    expect(d.nextDelayMs).toBe(2000);
  });
});
