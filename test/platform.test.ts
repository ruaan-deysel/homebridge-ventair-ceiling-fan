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
const { discover } = await import('../src/tuya/discovery.js');
const { matterUuid } = await import('../src/matter.js');

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

  it('unregisters stale accessories even when the configured device list is empty', async () => {
    const { log, api, handlers } = harness();
    const platform = new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [] } as never, api as never);

    const stale = { UUID: 'uuid-gone', displayName: 'Removed Fan', context: {} };
    platform.configureAccessory(stale as never);

    await handlers.didFinishLaunching?.();
    await vi.waitFor(() => expect(api.unregisterPlatformAccessories).toHaveBeenCalled());

    const [, , removed] = api.unregisterPlatformAccessories.mock.calls[0];
    expect(removed).toEqual([stale]);
  });

  it('still sets up a device with a static ip when discovery throws', async () => {
    const { log, api, handlers } = harness();
    (discover as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network down'));

    // resolveAddresses() only calls discover() at all if some device is missing an
    // explicit ip — mix a discovered-address device in alongside the static one so
    // discovery is actually attempted (and fails).
    const staticDevice = { ...device, id: 'c'.repeat(20), name: 'Static IP Fan', ip: '192.0.2.20' };
    const discoveredDevice = { ...device, id: 'd'.repeat(20), name: 'Discovered Fan' };
    new HomebridgeVentairCeilingFan(
      log as never,
      { platform: 'x', devices: [staticDevice, discoveredDevice] } as never,
      api as never,
    );
    await handlers.didFinishLaunching?.();

    await vi.waitFor(() => expect(api.registerPlatformAccessories).toHaveBeenCalled());
    const registered = api.registerPlatformAccessories.mock.calls.map(([, , accessories]) => accessories[0].displayName);
    expect(registered).toContain('Static IP Fan');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('discovery'), 'network down');
    // The failure was contained — it did not propagate to the top-level catch.
    expect(log.error).not.toHaveBeenCalled();
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

  it('re-registers a Matter fan restored from the cache so live handlers attach after restart', async () => {
    // Simulates a restart: configureMatterAccessory() (called by Homebridge before
    // didFinishLaunching, restoring the on-disk cache) already populated
    // matterAccessories with this UUID *before* discoverDevices() ever runs.
    const { log, api, handlers, matter } = matterHarness();
    const matterDevice = { ...device, exposeMatter: true };
    const platform = new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [matterDevice] } as never, api as never);

    const cachedFromDisk = { UUID: matterUuid(matterDevice.id), displayName: 'Family Room Fan (restored, no handlers)' };
    platform.configureMatterAccessory(cachedFromDisk as never);

    await handlers.didFinishLaunching?.();

    // The cached-from-disk accessory has no live handlers (Homebridge's Matter cache
    // never restores them) — registerPlatformAccessories must still be called with the
    // freshly-built accessory so the transport/onDps handlers actually go live.
    await vi.waitFor(() => expect(matter.registerPlatformAccessories).toHaveBeenCalled());
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
