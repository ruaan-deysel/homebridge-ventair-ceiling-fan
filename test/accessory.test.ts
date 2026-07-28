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
  const service = (name: string) => ({
    setCharacteristic() { return service(name); },
    getCharacteristic(c: string) { return characteristic(`${name}.${c}`); },
    updateCharacteristic: vi.fn(),
    displayName: name,
  });

  // Keyed by `${type}:${subtype ?? ''}` so a second construction against the same
  // accessory (simulating a Homebridge restart restoring from cache) finds services
  // already attached instead of re-adding them — the bug this harness now guards.
  const services = new Map<string, ReturnType<typeof service>>();

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
    const svc = service(name ?? t);
    services.set(`${t}:${subtype ?? ''}`, svc);
    return svc;
  });

  const accessory = {
    context: {} as Record<string, unknown>,
    getService: (t: string) => services.get(`${t}:`),
    addService,
    getServiceById: (t: string, subtype: string) => services.get(`${t}:${subtype}`),
    removeService: vi.fn((svc: unknown) => {
      for (const [key, value] of services) {
        if (value === svc) {
          services.delete(key);
        }
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
});
