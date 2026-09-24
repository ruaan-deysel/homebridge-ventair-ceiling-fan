import { describe, expect, it, vi } from 'vitest';

import { CeilingFanAccessory } from '../src/accessory.js';
import type { VentairDevice } from '../src/config.js';
import { DP, type FanState, MODE_NORMAL, MODE_SLEEP } from '../src/dps.js';
import {
  buildMatterAccessory,
  MatterFanBridge,
  matterLevelToPercent,
  matterUuid,
  percentToMatterLevel,
} from '../src/matter.js';
import { FanStateManager } from '../src/state.js';
import { FakeTuyaDevice } from '../src/tuya/device.js';

function fakeMatterApi() {
  return {
    deviceTypes: {
      Fan: { name: 'Fan', code: 0x002b },
      DimmableLight: { name: 'DimmableLight', code: 0x0101 },
      OnOffSwitch: { name: 'OnOffSwitch', code: 0x0103 },
      OnOffOutlet: { name: 'OnOffOutlet', code: 0x010a },
    },
    clusterNames: {
      OnOff: 'onOff',
      FanControl: 'fanControl',
      LevelControl: 'levelControl',
    },
    types: {
      FanControl: {
        FanMode: { Off: 0, Low: 1, Medium: 2, High: 3, On: 4, Auto: 5, Smart: 6 },
        FanModeSequence: { OffLowMedHigh: 0, OffLowHigh: 1, OffLowMedHighAuto: 2 },
      },
    },
    updateAccessoryState: vi.fn().mockResolvedValue(undefined),
    registerPlatformAccessories: vi.fn().mockResolvedValue(undefined),
    unregisterPlatformAccessories: vi.fn().mockResolvedValue(undefined),
  };
}

const baseDevice: VentairDevice = {
  id: 'a'.repeat(20),
  key: 'k'.repeat(16),
  name: 'Bedroom Fan',
  hasLight: false,
  exposeModeSwitches: false,
  version: '3.3',
};

const defaultState: FanState = {
  power: false,
  mode: MODE_NORMAL,
  speedStep: 0,
  direction: 'forward',
  lightPower: false,
  lightBrightness: 100,
};

describe('Matter descriptor and level conversion', () => {
  it('derives a deterministic Matter UUID distinct from the raw device id', () => {
    const uuid1 = matterUuid(baseDevice.id);
    const uuid2 = matterUuid(baseDevice.id);
    expect(uuid1).toBe(uuid2);
    expect(uuid1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(matterUuid('b'.repeat(20))).not.toBe(uuid1);
  });

  it('maps brightness percentages to Matter LevelControl 1..254 and back without out-of-range values', () => {
    expect(percentToMatterLevel(0)).toBe(1);
    expect(percentToMatterLevel(1)).toBe(1);
    expect(percentToMatterLevel(100)).toBe(254);
    expect(matterLevelToPercent(1)).toBe(1);
    expect(matterLevelToPercent(254)).toBe(100);
    expect(matterLevelToPercent(0)).toBe(0);
  });

  it('builds a Fan accessory with no parts when hasLight and exposeModeSwitches are false', () => {
    const api = fakeMatterApi();
    const acc = buildMatterAccessory(api as never, baseDevice, { ...defaultState, power: true, speedStep: 3 });

    expect(acc.UUID).toBe(matterUuid(baseDevice.id));
    expect(acc.deviceType).toBe(api.deviceTypes.Fan);
    expect(acc.clusters).toEqual({
      onOff: { onOff: true },
      fanControl: {
        fanMode: 2, // Medium
        fanModeSequence: 0, // OffLowMedHigh
        percentCurrent: 60,
        percentSetting: 60,
      },
    });
    expect(acc.parts).toBeUndefined();
  });

  it('includes composed DimmableLight and Sleep OnOffSwitch parts when enabled', () => {
    const api = fakeMatterApi();
    const acc = buildMatterAccessory(
      api as never,
      { ...baseDevice, hasLight: true, exposeModeSwitches: true },
      { ...defaultState, mode: MODE_SLEEP, lightPower: true, lightBrightness: 100 },
    );

    expect(acc.parts).toHaveLength(2);
    const lightPart = acc.parts?.find(p => p.id === 'light');
    const sleepPart = acc.parts?.find(p => p.id === 'sleep');

    expect(lightPart?.deviceType).toBe(api.deviceTypes.DimmableLight);
    expect(lightPart?.clusters).toEqual({
      onOff: { onOff: true },
      levelControl: { currentLevel: 254, minLevel: 1, maxLevel: 254 },
    });

    expect(sleepPart?.deviceType).toBe(api.deviceTypes.OnOffSwitch);
    expect(sleepPart?.clusters).toEqual({
      onOff: { onOff: true },
    });
  });
});

describe('MatterFanBridge and shared FanStateManager', () => {
  it('routes fan, light, and sleep commands through FanStateManager and pushes state to Matter', async () => {
    const api = fakeMatterApi();
    const transport = new FakeTuyaDevice();
    await transport.connect();
    const log = { debug: vi.fn(), warn: vi.fn() };
    const device = { ...baseDevice, hasLight: true, exposeModeSwitches: true };
    const stateManager = new FanStateManager(device, transport, log);
    const bridge = new MatterFanBridge(api as never, device, stateManager, log);
    const acc = bridge.buildAccessory();

    await acc.handlers?.fanControl?.percentSettingChange?.({ percentSetting: 80, oldPercentSetting: 0 });
    expect(transport.state[DP.power]).toBe(true);
    expect(transport.state[DP.speed]).toBe(4);
    expect(api.updateAccessoryState).toHaveBeenCalledWith(
      bridge.uuid,
      'fanControl',
      expect.objectContaining({ fanMode: 3, percentCurrent: 80, percentSetting: 80 }),
    );

    await acc.handlers?.fanControl?.fanModeChange?.({ fanMode: 1 as never, oldFanMode: 3 as never });
    expect(transport.state[DP.speed]).toBe(1);

    const lightPart = acc.parts?.find(p => p.id === 'light');
    await lightPart?.handlers?.onOff?.on?.({});
    expect(transport.state[DP.lightPower]).toBe(true);
    expect(api.updateAccessoryState).toHaveBeenCalledWith(
      bridge.uuid,
      'onOff',
      { onOff: true },
      'light',
    );

    await lightPart?.handlers?.levelControl?.moveToLevel?.({ level: 254 } as never);
    expect(transport.state[DP.lightBrightness]).toBe(100);

    const sleepPart = acc.parts?.find(p => p.id === 'sleep');
    await sleepPart?.handlers?.onOff?.on?.({});
    expect(transport.state[DP.mode]).toBe('Sleep');
    expect(api.updateAccessoryState).toHaveBeenCalledWith(
      bridge.uuid,
      'onOff',
      { onOff: true },
      'sleep',
    );
  });

  it('rolls back optimistic state, pushes the reconciled state to Matter, and rethrows when a Matter write fails', async () => {
    const api = fakeMatterApi();
    const transport = new FakeTuyaDevice();
    await transport.connect();
    const log = { debug: vi.fn(), warn: vi.fn() };
    const stateManager = new FanStateManager(baseDevice, transport, log);
    const bridge = new MatterFanBridge(api as never, baseDevice, stateManager, log);
    const acc = bridge.buildAccessory();

    transport.emitDps({ [DP.power]: false, [DP.speed]: 2 });
    api.updateAccessoryState.mockClear();

    vi.spyOn(transport, 'set').mockRejectedValueOnce(new Error('device unreachable'));

    await expect(acc.handlers?.onOff?.on?.({})).rejects.toThrow('device unreachable');
    expect(stateManager.state.power).toBe(false);
    expect(api.updateAccessoryState).toHaveBeenCalledWith(
      bridge.uuid,
      'onOff',
      { onOff: false },
    );
  });

  it('keeps HAP and Matter in lockstep through a single FanStateManager with no state divergence', async () => {
    const api = fakeMatterApi();
    const transport = new FakeTuyaDevice();
    await transport.connect();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const hapHandlers = new Map<string, { onSet?: (v: unknown) => Promise<void>; onGet?: () => unknown }>();
    const fanService = {
      UUID: 'Fanv2',
      setCharacteristic: vi.fn().mockReturnThis(),
      getCharacteristic: (c: string) => {
        const entry = hapHandlers.get(c) ?? {};
        hapHandlers.set(c, entry);
        const chain = {
          onSet(fn: (v: unknown) => Promise<void>) { entry.onSet = fn; return chain; },
          onGet(fn: () => unknown) { entry.onGet = fn; return chain; },
          setProps() { return chain; },
        };
        return chain;
      },
      updateCharacteristic: vi.fn(),
    };
    const hapAccessory = {
      context: {},
      services: [fanService],
      getService: (t: string) => (t === 'Fanv2' ? fanService : undefined),
      addService: () => fanService,
      removeService: vi.fn(),
    };
    const platform = {
      log,
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

    const stateManager = new FanStateManager(baseDevice, transport, log);
    new CeilingFanAccessory(platform as never, hapAccessory as never, baseDevice, transport, stateManager);
    const matterBridge = new MatterFanBridge(api as never, baseDevice, stateManager, log);
    const matterAcc = matterBridge.buildAccessory();

    // A Matter speed change immediately updates HAP's state and characteristic push:
    await matterAcc.handlers?.fanControl?.percentSettingChange?.({ percentSetting: 60, oldPercentSetting: 0 });
    expect(hapHandlers.get('RotationSpeed')?.onGet?.()).toBe(60);
    expect(fanService.updateCharacteristic).toHaveBeenCalledWith('RotationSpeed', 60);

    // And a HAP speed change immediately pushes to Matter:
    api.updateAccessoryState.mockClear();
    await hapHandlers.get('RotationSpeed')?.onSet?.(100);
    expect(api.updateAccessoryState).toHaveBeenCalledWith(
      matterBridge.uuid,
      'fanControl',
      expect.objectContaining({ percentCurrent: 100, percentSetting: 100 }),
    );
  });
});
