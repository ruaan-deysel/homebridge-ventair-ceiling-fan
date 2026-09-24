import { describe, expect, it, vi } from 'vitest';

import { DP } from '../src/dps.js';
import { FanStateManager } from '../src/state.js';
import { FakeTuyaDevice } from '../src/tuya/device.js';

function makeManager() {
  const transport = new FakeTuyaDevice();
  const log = { debug: vi.fn(), warn: vi.fn() };
  const manager = new FanStateManager({ name: 'Family Room Fan' }, transport, log);
  return { transport, log, manager };
}

describe('FanStateManager', () => {
  it('publishes inbound DPs to subscribers and updates state', () => {
    const { transport, manager } = makeManager();
    const patches: unknown[] = [];
    manager.onChange(patch => patches.push(patch));

    transport.emitDps({ [DP.power]: true, [DP.speed]: 3, [DP.mode]: 'Sleep' });

    expect(manager.state).toMatchObject({
      power: true,
      speedStep: 3,
      mode: 'sleep',
    });
    expect(patches).toEqual([{ power: true, speedStep: 3, mode: 'sleep' }]);
  });

  it('refreshes from transport.get() on connect', async () => {
    const { transport, manager } = makeManager();
    vi.spyOn(transport, 'get').mockResolvedValue({ [DP.power]: true, [DP.speed]: 4 });

    await transport.connect();
    await vi.waitFor(() => expect(manager.state.speedStep).toBe(4));
    expect(manager.state.power).toBe(true);
  });

  it('isolates subscriber errors so one throwing listener never breaks another', async () => {
    const { transport, manager } = makeManager();
    await transport.connect();

    const seen: unknown[] = [];
    manager.onChange(() => {
      throw new Error('listener boom');
    });
    manager.onChange(patch => seen.push(patch));

    await manager.setSpeedPercent(80);
    expect(seen).toEqual([{ power: true, speedStep: 4 }]);
  });

  it('supports unsubscribing via the returned disposer', () => {
    const { transport, manager } = makeManager();
    const seen: unknown[] = [];
    const unsubscribe = manager.onChange(patch => seen.push(patch));

    unsubscribe();
    transport.emitDps({ [DP.power]: true });

    expect(seen).toEqual([]);
  });
});
