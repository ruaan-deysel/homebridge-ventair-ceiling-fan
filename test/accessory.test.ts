import { describe, expect, it, vi } from 'vitest';
import { DP } from '../src/dps.js';
import { FakeTuyaDevice } from '../src/tuya/device.js';
import { CeilingFanAccessory } from '../src/accessory.js';

// Minimal HAP doubles: record handlers so tests can invoke them directly.
function harness(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, { onSet?: (v: unknown) => Promise<void>; onGet?: () => unknown }>();
  const characteristic = (key: string) => {
    const entry = handlers.get(key) ?? {};
    handlers.set(key, entry);
    const chain = {
      onSet(fn: (v: unknown) => Promise<void>) { entry.onSet = fn; return chain; },
      onGet(fn: () => unknown) { entry.onGet = fn; return chain; },
      setProps() { return chain; },
      updateValue() { return chain; },
    };
    return chain;
  };
  // UUID/subtype fields mirror real HAP Service instances closely enough for the
  // accessory's own getService/getServiceById/services-filter reconciliation logic
  // to behave the same way it does against a real Homebridge accessory.
  const service = (name: string, uuid: string, subtype?: string) => ({
    UUID: uuid,
    subtype,
    setCharacteristic() { return service(name, uuid, subtype); },
    getCharacteristic(c: string) { return characteristic(`${name}.${c}`); },
    updateCharacteristic: vi.fn(),
    displayName: name,
  });

  // A live array, like `PlatformAccessory.services` — a second construction against
  // the same accessory (simulating a Homebridge restart restoring from cache) sees
  // whatever services are already attached instead of a fresh empty store.
  const services: ReturnType<typeof service>[] = [];

  const platform = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    Service: { AccessoryInformation: 'Info', Fanv2: 'Fanv2', Lightbulb: 'Lightbulb', Switch: 'Switch' },
    Characteristic: {
      Manufacturer: 'Manufacturer', Model: 'Model', Name: 'Name', ConfiguredName: 'ConfiguredName',
      SerialNumber: 'SerialNumber', FirmwareRevision: 'FirmwareRevision',
      Active: Object.assign('Active', { ACTIVE: 1, INACTIVE: 0 }),
      RotationSpeed: 'RotationSpeed',
      RotationDirection: Object.assign('RotationDirection', { CLOCKWISE: 0, COUNTER_CLOCKWISE: 1 }),
      On: 'On', Brightness: 'Brightness',
    },
    api: { hap: { HapStatusError: class extends Error {}, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } } },
  };

  const addService = vi.fn((t: string, name?: string, subtype?: string) => {
    const svc = service(name ?? t, t, subtype);
    services.push(svc);
    return svc;
  });

  const accessory = {
    context: {} as Record<string, unknown>,
    services,
    // Real getService() matches by UUID only — first hit wins regardless of subtype.
    getService: (t: string) => services.find(s => s.UUID === t),
    addService,
    getServiceById: (t: string, subtype: string) => services.find(s => s.UUID === t && s.subtype === subtype),
    removeService: vi.fn((svc: unknown) => {
      const i = services.indexOf(svc as (typeof services)[number]);
      if (i !== -1) {
        services.splice(i, 1);
      }
    }),
  };

  const device = { id: 'a'.repeat(20), key: 'k'.repeat(16), name: 'Family Room Fan', hasLight: false, exposeModeSwitches: false, version: '3.3' as const, ...overrides };
  return { platform, accessory, device, handlers };
}

describe('fan control', () => {
  it('turning speed to 0 powers the fan off', async () => {
    const { platform, accessory, device, handlers } = harness();
    const transport = new FakeTuyaDevice();
    await transport.connect();
    new CeilingFanAccessory(platform as never, accessory as never, device as never, transport);

    await handlers.get('Fanv2.RotationSpeed')?.onSet?.(0);
    expect(transport.state[DP.power]).toBe(false);
  });

  it('powering on from a stopped state restores step 1', async () => {
    const { platform, accessory, device, handlers } = harness();
    const transport = new FakeTuyaDevice();
    await transport.connect();
    new CeilingFanAccessory(platform as never, accessory as never, device as never, transport);

    await handlers.get('Fanv2.Active')?.onSet?.(1);
    expect(transport.state[DP.power]).toBe(true);
    expect(transport.state[DP.speed]).toBe(1);
  });

  it('throws while disconnected instead of reporting stale state', async () => {
    const { platform, accessory, device, handlers } = harness();
    const transport = new FakeTuyaDevice(); // never connected
    new CeilingFanAccessory(platform as never, accessory as never, device as never, transport);

    expect(() => handlers.get('Fanv2.Active')?.onGet?.()).toThrow();
  });

  it('sleep switch on writes Sleep, off writes Normal', async () => {
    const { platform, accessory, device, handlers } = harness({ exposeModeSwitches: true });
    const transport = new FakeTuyaDevice();
    await transport.connect();
    new CeilingFanAccessory(platform as never, accessory as never, device as never, transport);

    // Device accepts only Normal and Sleep, and requires capitalised strings.
    await handlers.get('Sleep.On')?.onSet?.(true);
    expect(transport.state[DP.mode]).toBe('Sleep');

    await handlers.get('Sleep.On')?.onSet?.(false);
    expect(transport.state[DP.mode]).toBe('Normal');
  });

  it('exposes no mode switch when exposeModeSwitches is false', async () => {
    const { platform, accessory, device, handlers } = harness({ exposeModeSwitches: false });
    const transport = new FakeTuyaDevice();
    await transport.connect();
    new CeilingFanAccessory(platform as never, accessory as never, device as never, transport);

    expect(handlers.get('Sleep.On')).toBeUndefined();
  });

  it('restoring from cache does not duplicate or throw on the Sleep switch', async () => {
    const { platform, accessory, device, handlers } = harness({ exposeModeSwitches: true });

    const transport1 = new FakeTuyaDevice();
    await transport1.connect();
    new CeilingFanAccessory(platform as never, accessory as never, device as never, transport1);
    const callsAfterFirst = (accessory.addService as ReturnType<typeof vi.fn>).mock.calls.length;

    // Simulates a Homebridge restart: same accessory object, already carrying the
    // Switch service from the first construction.
    const transport2 = new FakeTuyaDevice();
    await transport2.connect();
    expect(() => new CeilingFanAccessory(platform as never, accessory as never, device as never, transport2))
      .not.toThrow();

    expect((accessory.addService as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
    expect(handlers.get('Sleep.On')).toBeDefined();
  });

  it('adopts a legacy subtype-less Sleep switch instead of orphaning it', async () => {
    const { platform, accessory, device } = harness({ exposeModeSwitches: true });
    // Pre-fix cached accessories carry a Switch with no subtype at all — the exact
    // shape round-1's bare `addService(S.Switch, label)` used to create.
    const legacy = accessory.addService('Switch', 'Sleep');

    const transport = new FakeTuyaDevice();
    await transport.connect();
    expect(() => new CeilingFanAccessory(platform as never, accessory as never, device as never, transport))
      .not.toThrow();

    const switches = accessory.services.filter(s => s.UUID === 'Switch');
    expect(switches).toHaveLength(1);
    expect(switches[0]).toBe(legacy);
  });

  it('consolidates a legacy switch plus the round-1 subtyped duplicate into one', async () => {
    const { platform, accessory, device } = harness({ exposeModeSwitches: true });
    // Reproduces the live bridge state: the original subtype-less Switch, plus the
    // subtyped one round-1's getServiceById(Switch, 'sleep') added alongside it
    // because it never matched the untyped one.
    accessory.addService('Switch', 'Sleep');
    const subtyped = accessory.addService('Switch', 'Sleep', 'sleep');
    expect(accessory.services.filter(s => s.UUID === 'Switch')).toHaveLength(2);

    const transport = new FakeTuyaDevice();
    await transport.connect();
    new CeilingFanAccessory(platform as never, accessory as never, device as never, transport);

    const switches = accessory.services.filter(s => s.UUID === 'Switch');
    expect(switches).toHaveLength(1);
    expect(switches[0]).toBe(subtyped);
  });

  it('write() rolls back optimistic state and throws SERVICE_COMMUNICATION_FAILURE on a rejected transport write', async () => {
    const { platform, accessory, device, handlers } = harness({ exposeModeSwitches: true });
    const transport = new FakeTuyaDevice();
    await transport.connect();
    vi.spyOn(transport, 'set').mockRejectedValue(new Error('device unreachable'));
    new CeilingFanAccessory(platform as never, accessory as never, device as never, transport);
    // The device reports its own state first. Rollback restores that confirmed value —
    // never the failed write's optimistic snapshot, which under overlapping writes can
    // hold a value the fan never received.
    transport.emitDps({ [DP.mode]: 'Normal' });

    // Sleep.On's onSet chains write().then(syncModeSwitch); write() now rejects on a
    // failed transport write instead of swallowing the error, so HomeKit reverts the
    // switch instead of showing a value the hardware never took.
    await expect(handlers.get('Sleep.On')?.onSet?.(true)).rejects.toThrow();
    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('write failed'),
      'device unreachable',
    );
    // State was rolled back to its pre-write value (mode stayed Normal, not Sleep).
    expect(handlers.get('Sleep.On')?.onGet?.()).toBe(false);
  });

  it('an older write failing after a newer write already succeeded does not roll back the newer state', async () => {
    // Reproduces: two RotationSpeed commands land close together (e.g. a HomeKit
    // automation immediately followed by a user drag). The older one is still
    // in flight on the wire when the newer one starts, applies its own optimistic
    // state, and succeeds. Only THEN does the older command's write fail. Before
    // version-gating, its rollback unconditionally restored its own pre-write
    // snapshot — wiping out the newer command's already-confirmed success even
    // though the fan genuinely holds the newer value.
    const { platform, accessory, device, handlers } = harness();
    const transport = new FakeTuyaDevice();
    await transport.connect();
    new CeilingFanAccessory(platform as never, accessory as never, device as never, transport);

    let rejectOlder!: (error: unknown) => void;
    const olderSetPromise = new Promise<void>((_, reject) => {
      rejectOlder = reject;
    });
    // Only the very next transport.set() call (the older write's) hangs — the newer
    // write's call falls through to FakeTuyaDevice's normal, immediately-resolving
    // behaviour.
    vi.spyOn(transport, 'set').mockImplementationOnce(() => olderSetPromise);

    const older = handlers.get('Fanv2.RotationSpeed')?.onSet?.(20); // step 1, stuck in flight
    await handlers.get('Fanv2.RotationSpeed')?.onSet?.(60); // step 3, completes first

    expect(handlers.get('Fanv2.RotationSpeed')?.onGet?.()).toBe(60);
    expect(transport.state[DP.speed]).toBe(3);

    // Now the older, superseded write finally fails.
    rejectOlder(new Error('device unreachable'));
    await expect(older).rejects.toThrow();

    // The newer, successful value must survive — nothing rolled it back.
    expect(handlers.get('Fanv2.RotationSpeed')?.onGet?.()).toBe(60);
    expect(transport.state[DP.speed]).toBe(3);
    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('write failed'),
      'device unreachable',
    );
    // fails if reverted: an unconditional `Object.assign(this.state, previous)` in
    // write()'s catch restores speedStep to 0/power to false here, and the assertions
    // above fail.
  });

  it('does not restore a superseded write value the fan never received when reconciliation cannot read the device', async () => {
    // Three overlapping speed commands; the last one fails. Its own pre-write snapshot
    // holds the SECOND command's optimistic value — a value that was never sent to the
    // fan, because that command is still stuck in flight. With the authoritative read
    // unavailable too, the only trustworthy fallback is the last value the device itself
    // reported, not the accessory's own guess.
    const { platform, accessory, device, handlers } = harness();
    const transport = new FakeTuyaDevice();
    await transport.connect();
    new CeilingFanAccessory(platform as never, accessory as never, device as never, transport);

    // The fan tells us what it is actually doing: full speed.
    transport.emitDps({ [DP.power]: true, [DP.speed]: 5 });
    expect(handlers.get('Fanv2.RotationSpeed')?.onGet?.()).toBe(100);

    // The device goes unreachable: the two earlier writes hang on the wire, the third
    // rejects, and the reconciling read cannot get through either.
    vi.spyOn(transport, 'get').mockRejectedValue(new Error('device unreachable'));
    vi.spyOn(transport, 'set')
      .mockImplementationOnce(() => new Promise<void>(() => {})) // step 1 — stuck in flight
      .mockImplementationOnce(() => new Promise<void>(() => {})) // step 2 — stuck in flight
      .mockRejectedValueOnce(new Error('device unreachable')); // step 3 — fails

    void handlers.get('Fanv2.RotationSpeed')?.onSet?.(20);
    void handlers.get('Fanv2.RotationSpeed')?.onSet?.(40);
    await expect(handlers.get('Fanv2.RotationSpeed')?.onSet?.(60)).rejects.toThrow();

    // 40% is the superseded middle command's optimistic value — the fan never saw it.
    expect(handlers.get('Fanv2.RotationSpeed')?.onGet?.()).toBe(100);
    // fails if reverted: the `previous[key]` fallback restores 40 here, publishing a
    // speed the hardware never held.
  });

  it('removes every Sleep switch when exposeModeSwitches is off, not just the subtyped one', async () => {
    const { platform, accessory, device } = harness({ exposeModeSwitches: false });
    accessory.addService('Switch', 'Sleep');
    accessory.addService('Switch', 'Sleep', 'sleep');

    const transport = new FakeTuyaDevice();
    await transport.connect();
    new CeilingFanAccessory(platform as never, accessory as never, device as never, transport);

    expect(accessory.services.filter(s => s.UUID === 'Switch')).toHaveLength(0);
  });
});
