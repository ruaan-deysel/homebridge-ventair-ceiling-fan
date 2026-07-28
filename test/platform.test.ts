import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/tuya/discovery.js', () => ({
  discover: vi.fn().mockResolvedValue([{ id: 'a'.repeat(20), ip: '192.0.2.11', version: '3.3' }]),
}));

// Platform lifecycle tests care about discovery/register/unregister wiring, not accessory
// internals — mocking this out decouples the two, which is also what let one throwing
// accessory be simulated below without needing real HAP service internals.
vi.mock('../src/accessory.js', () => ({
  CeilingFanAccessory: vi.fn(),
}));

const { HomebridgeVentairCeilingFan } = await import('../src/platform.js');
const { CeilingFanAccessory } = await import('../src/accessory.js');

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
    isMatterEnabled: () => false,
    matter: undefined,
  };
  return { log, api, handlers };
}

function matterHarness() {
  const base = harness();
  const matter = {
    deviceTypes: { Fan: 'FanDevice' },
    clusterNames: { OnOff: 'onOff', FanControl: 'fanControl' },
    registerPlatformAccessories: vi.fn().mockResolvedValue(undefined),
    unregisterPlatformAccessories: vi.fn().mockResolvedValue(undefined),
    updateAccessoryState: vi.fn().mockResolvedValue(undefined),
  };
  base.api.isMatterEnabled = () => true;
  base.api.matter = matter;
  return { ...base, matter };
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

  it('sets up remaining devices when one device setup throws', async () => {
    const { log, api, handlers } = harness();
    (CeilingFanAccessory as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const devices = [
      { ...device, id: 'a'.repeat(20), name: 'Broken Fan' },
      { ...device, id: 'b'.repeat(20), name: 'Good Fan' },
    ];
    new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices } as never, api as never);
    await handlers.didFinishLaunching?.();
    await vi.waitFor(() => expect(api.registerPlatformAccessories).toHaveBeenCalled());

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Broken Fan'), expect.anything());
    const registered = api.registerPlatformAccessories.mock.calls.map(([, , accessories]) => accessories[0].displayName);
    expect(registered).toContain('Good Fan');
    expect(registered).not.toContain('Broken Fan');
  });
});

describe('Matter', () => {
  it('does not touch api.matter when exposeMatter is off', async () => {
    const { log, api, handlers } = harness();
    new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [device] } as never, api as never);
    await handlers.didFinishLaunching?.();
    await vi.waitFor(() => expect(api.registerPlatformAccessories).toHaveBeenCalled());
    expect(api.isMatterEnabled).toBeDefined();
  });

  it('registers a Matter fan when exposeMatter is on and Matter is enabled', async () => {
    const { log, api, handlers, matter } = matterHarness();
    const matterDevice = { ...device, exposeMatter: true };
    new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [matterDevice] } as never, api as never);
    await handlers.didFinishLaunching?.();
    await vi.waitFor(() => expect(matter.registerPlatformAccessories).toHaveBeenCalled());

    const [pluginId, platformName, accessories] = matter.registerPlatformAccessories.mock.calls[0];
    expect(pluginId).toBe('homebridge-ventair-ceiling-fan');
    expect(platformName).toBe('HomebridgeVentairCeilingFan');
    expect(accessories[0].deviceType).toBe('FanDevice');
    expect(accessories[0].UUID).not.toBe(api.hap.uuid.generate(matterDevice.id));
  });

  it('never calls api.matter when exposeMatter is on but Matter is not enabled', async () => {
    const { log, api, handlers } = harness();
    const matterDevice = { ...device, exposeMatter: true };
    new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [matterDevice] } as never, api as never);
    await handlers.didFinishLaunching?.();
    await vi.waitFor(() => expect(api.registerPlatformAccessories).toHaveBeenCalled());
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Matter'));
  });

  it('unregisters stale Matter accessories no longer in config', async () => {
    const { log, api, handlers, matter } = matterHarness();
    const platform = new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [device] } as never, api as never);

    const staleMatter = { UUID: 'stale-matter-uuid', displayName: 'Removed Matter Fan' };
    platform.configureMatterAccessory(staleMatter as never);

    await handlers.didFinishLaunching?.();
    await vi.waitFor(() => expect(matter.unregisterPlatformAccessories).toHaveBeenCalled());

    const [, , removed] = matter.unregisterPlatformAccessories.mock.calls[0];
    expect(removed).toEqual([staleMatter]);
  });

  it('catches and logs a rejected Matter unregister instead of an unhandled rejection', async () => {
    const { log, api, handlers, matter } = matterHarness();
    matter.unregisterPlatformAccessories.mockRejectedValue(new Error('bridge unreachable'));
    const platform = new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [device] } as never, api as never);

    const staleMatter = { UUID: 'stale-matter-uuid', displayName: 'Removed Matter Fan' };
    platform.configureMatterAccessory(staleMatter as never);

    await handlers.didFinishLaunching?.();
    await vi.waitFor(() => expect(matter.unregisterPlatformAccessories).toHaveBeenCalled());
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('stale Matter'),
      'bridge unreachable',
    );
    // The rejection did not propagate to the top-level discoverDevices().catch handler.
    expect(log.error).not.toHaveBeenCalled();
  });
});
