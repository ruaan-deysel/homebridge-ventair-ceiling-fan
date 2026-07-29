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

// Transport construction is what carries the resolved protocol version — mocked so the
// tests can assert on the options it was handed without opening a socket.
vi.mock('../src/tuya/tuyapi.js', () => ({
  TuyapiDevice: vi.fn(class {
    connected = false;
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    set = vi.fn().mockResolvedValue(undefined);
    get = vi.fn().mockResolvedValue({});
    onDps = vi.fn(() => () => {});
    onConnected = vi.fn();
    onDisconnected = vi.fn();
  }),
}));

const { HomebridgeVentairCeilingFan } = await import('../src/platform.js');
const { CeilingFanAccessory } = await import('../src/accessory.js');
const { TuyapiDevice } = await import('../src/tuya/tuyapi.js');
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

  it('keeps the cached accessory of a device whose config failed validation', async () => {
    // parseDevices() drops an invalid entry, but the entry is still IN the config — the
    // user mistyped a key, they did not remove the fan. Unregistering it here would throw
    // away its room, scenes and automations for a typo, which the plugin cannot undo.
    const { log, api, handlers } = harness();
    const broken = { ...device, id: 'e'.repeat(20), name: 'Typo Fan', key: 'too-short' };
    const platform = new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [broken] } as never, api as never);

    const cached = { UUID: `uuid-${broken.id}`, displayName: 'Typo Fan', context: {} };
    platform.configureAccessory(cached as never);

    await handlers.didFinishLaunching?.();

    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    expect(platform.accessories.has(cached.UUID)).toBe(true);
  });

  it('still unregisters a cached accessory whose device was removed from config, alongside an invalid one', async () => {
    const { log, api, handlers } = harness();
    const broken = { ...device, id: 'e'.repeat(20), name: 'Typo Fan', key: 'too-short' };
    const platform = new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [broken] } as never, api as never);

    platform.configureAccessory({ UUID: `uuid-${broken.id}`, displayName: 'Typo Fan', context: {} } as never);
    const gone = { UUID: 'uuid-gone', displayName: 'Removed Fan', context: {} };
    platform.configureAccessory(gone as never);

    await handlers.didFinishLaunching?.();
    await vi.waitFor(() => expect(api.unregisterPlatformAccessories).toHaveBeenCalled());

    const [, , removed] = api.unregisterPlatformAccessories.mock.calls[0];
    expect(removed).toEqual([gone]);
  });

  it('gives the transport the protocol version discovery reported when config does not set one', async () => {
    const { log, api, handlers } = harness();
    (TuyapiDevice as unknown as ReturnType<typeof vi.fn>).mockClear();
    (discover as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: device.id, ip: '192.0.2.11', version: '3.4' }]);

    new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [device] } as never, api as never);
    await handlers.didFinishLaunching?.();
    await vi.waitFor(() => expect(TuyapiDevice).toHaveBeenCalled());

    const [opts] = (TuyapiDevice as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [{ version: string; ip?: string }];
    expect(opts.version).toBe('3.4');
    expect(opts.ip).toBe('192.0.2.11');
  });

  it('lets an explicitly configured version win over the discovered one', async () => {
    const { log, api, handlers } = harness();
    (TuyapiDevice as unknown as ReturnType<typeof vi.fn>).mockClear();
    (discover as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: device.id, ip: '192.0.2.11', version: '3.4' }]);

    new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [{ ...device, version: '3.3' }] } as never, api as never);
    await handlers.didFinishLaunching?.();
    await vi.waitFor(() => expect(TuyapiDevice).toHaveBeenCalled());

    const [opts] = (TuyapiDevice as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [{ version: string }];
    expect(opts.version).toBe('3.3');
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

  it('preserves a cached Matter accessory when its setup fails this run, instead of treating it as removed from config', async () => {
    // Regression guard: the desired-Matter-UUID set used for stale cleanup must be
    // computed from valid CONFIG alone, before any setup is attempted — never from
    // "which devices' registerMatter() happened to succeed this run". A transient
    // failure (bridge not ready yet, one-off startup race, ...) on a still-configured,
    // already-cached Matter fan must not make removeStaleMatterAccessories() treat its
    // cached UUID as stale and unregister it — that destroys the user's cached Matter
    // endpoint state over what is often just a one-off error.
    const { log, api, handlers, matter } = matterHarness();
    const matterDevice = { ...device, exposeMatter: true };
    matter.registerPlatformAccessories.mockRejectedValueOnce(new Error('bridge not ready'));

    const platform = new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [matterDevice] } as never, api as never);
    const cachedFromDisk = { UUID: matterUuid(matterDevice.id), displayName: 'Cached Fan (restored from disk)' };
    platform.configureMatterAccessory(cachedFromDisk as never);

    await handlers.didFinishLaunching?.();
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Setup failed'), expect.anything()));

    // The cached accessory must never have been classified as stale over a transient
    // setup failure — removeStaleMatterAccessories() must not even reach the point of
    // calling unregisterPlatformAccessories for it.
    expect(matter.unregisterPlatformAccessories).not.toHaveBeenCalled();
  });

  it('keeps a cached Matter accessory whose config entry failed validation', async () => {
    // The HAP stale path's sibling bug: a mistyped key drops the entry from the parsed
    // list, so its Matter UUID looks undesired and the endpoint gets destroyed. An entry
    // still present in config must keep its Matter accessory whether or not it parsed.
    const { log, api, handlers, matter } = matterHarness();
    const broken = { ...device, id: 'e'.repeat(20), name: 'Typo Matter Fan', key: 'too-short', exposeMatter: true };
    const platform = new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [broken] } as never, api as never);

    platform.configureMatterAccessory({ UUID: matterUuid(broken.id), displayName: 'Typo Matter Fan' } as never);

    await handlers.didFinishLaunching?.();

    expect(matter.unregisterPlatformAccessories).not.toHaveBeenCalled();
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
