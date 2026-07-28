import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/tuya/discovery.js', () => ({
  discover: vi.fn().mockResolvedValue([{ id: 'a'.repeat(20), ip: '192.0.2.11', version: '3.3' }]),
}));

const { HomebridgeVentairCeilingFan } = await import('../src/platform.js');

function harness() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), log: vi.fn() };
  const handlers: Record<string, () => void> = {};
  const api = {
    hap: {
      Service: { AccessoryInformation: 'info', Fanv2: 'fan', Lightbulb: 'light', Switch: 'switch' },
      Characteristic: {},
      Categories: { FAN: 3 },
      uuid: { generate: (s: string) => `uuid-${s}` },
    },
    on: (e: string, fn: () => void) => {
      handlers[e] = fn;
    },
    platformAccessory: class {
      context: Record<string, unknown> = {};
      services: unknown[] = [];
      constructor(public displayName: string, public UUID: string) {}
      getService() {
        return undefined;
      }
      addService() {
        const characteristic: Record<string, unknown> = {
          setProps() { return characteristic; },
          onSet() { return characteristic; },
          onGet() { return characteristic; },
          updateValue() { return characteristic; },
        };
        const service: Record<string, unknown> = {
          setCharacteristic() { return service; },
          getCharacteristic: () => characteristic,
          updateCharacteristic: () => service,
        };
        return service;
      }
    },
    registerPlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
  };
  return { log, api, handlers };
}

const device = { id: 'a'.repeat(20), key: 'k'.repeat(16), name: 'Family Room Fan' };

describe('platform lifecycle', () => {
  it('unregisters accessories no longer present in config', async () => {
    const { log, api, handlers } = harness();
    const platform = new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [device] } as never, api as never);

    const stale = { UUID: 'uuid-gone', displayName: 'Removed Fan', context: {} };
    platform.configureAccessory(stale as never);

    await handlers.didFinishLaunching?.();
    await vi.waitFor(() => expect(api.unregisterPlatformAccessories).toHaveBeenCalled());

    const [, , removed] = api.unregisterPlatformAccessories.mock.calls[0];
    expect(removed).toEqual([stale]);
  });

  it('registers a configured device that has no cached accessory', async () => {
    const { log, api, handlers } = harness();
    new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [device] } as never, api as never);
    await handlers.didFinishLaunching?.();
    await vi.waitFor(() => expect(api.registerPlatformAccessories).toHaveBeenCalled());
  });

  it('registers nothing when every device is invalid', async () => {
    const { log, api, handlers } = harness();
    new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [{ ...device, key: 'short' }] } as never, api as never);
    await handlers.didFinishLaunching?.();
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });
});
