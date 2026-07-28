import { describe, expect, it, vi } from 'vitest';
import { buildMatterAccessory, matterUuid } from '../src/matter.js';

const matterApi = {
  deviceTypes: { Fan: 'FanDevice' },
  clusterNames: { OnOff: 'onOff', FanControl: 'fanControl' },
};

const device = { id: 'a'.repeat(20), key: 'x'.repeat(16), name: 'Test Fan' };

/**
 * Matter's conformance validator rejects a FanControl endpoint missing any of these —
 * fanModeSequence was missed in the first pass and failed registration on a live bridge
 * with "Conformance M: Matter requires you to set this attribute". This list is the
 * regression guard: every entry is unconditionally mandatory per the FanControl base
 * attributes (Matter spec §4.4.6), independent of any optional feature (MultiSpeed,
 * Rocking, Wind, ...).
 */
const MANDATORY_FAN_CONTROL_ATTRIBUTES = ['fanMode', 'fanModeSequence', 'percentSetting', 'percentCurrent'] as const;

/**
 * `speedMax`/`speedCurrent`/`speedSetting` require the FanControl "Speed" (SPD) feature,
 * which the plain `deviceTypes.Fan` we register does not declare — Homebridge's Matter
 * plugin API has no way to opt in. Sending them anyway rolled back the *entire* state
 * update on a live bridge ("Conformance SPD: Matter does not allow you to set this
 * attribute"), including the always-allowed percent attributes. This is the regression
 * guard for that failure: the exact attribute set below (and only this set) must appear.
 */
const ALLOWED_FAN_CONTROL_ATTRIBUTES = ['fanMode', 'fanModeSequence', 'percentSetting', 'percentCurrent'] as const;

describe('buildMatterAccessory', () => {
  it('declares a Fan device with onOff and fanControl clusters', () => {
    const acc = buildMatterAccessory(matterApi as never, 'uuid-1', device as never, {
      power: true, speedStep: 3, mode: 'normal', direction: 'forward',
      lightPower: false, lightBrightness: 100,
    });
    expect(acc.deviceType).toBe('FanDevice');
    expect(acc.clusters!.onOff!.onOff).toBe(true);
    expect(acc.clusters!.fanControl!.percentCurrent).toBe(60);
    expect(acc.clusters!.fanControl!.fanMode).toBe(2); // Medium (step 3)
  });

  it('sets exactly the always-allowed FanControl attributes — nothing SPD-gated', () => {
    const acc = buildMatterAccessory(matterApi as never, 'uuid-1', device as never, {
      power: true, speedStep: 3, mode: 'normal', direction: 'forward',
      lightPower: false, lightBrightness: 100,
    });
    expect(Object.keys(acc.clusters!.fanControl!).sort()).toEqual([...ALLOWED_FAN_CONTROL_ATTRIBUTES].sort());
    expect(acc.clusters!.fanControl).not.toHaveProperty('speedMax');
    expect(acc.clusters!.fanControl).not.toHaveProperty('speedCurrent');
    expect(acc.clusters!.fanControl).not.toHaveProperty('speedSetting');
  });

  it('reports 0% and off when the fan is stopped', () => {
    const acc = buildMatterAccessory(matterApi as never, 'uuid-1', device as never, {
      power: false, speedStep: 0, mode: 'normal', direction: 'forward',
      lightPower: false, lightBrightness: 100,
    });
    expect(acc.clusters!.onOff!.onOff).toBe(false);
    expect(acc.clusters!.fanControl!.percentCurrent).toBe(0);
    expect(acc.clusters!.fanControl!.fanMode).toBe(0); // Off
  });

  it.each([
    [0, 0], // Off
    [1, 1], // Low
    [2, 1], // Low
    [3, 2], // Medium
    [4, 3], // High
    [5, 3], // High
  ])('maps speed step %i to Matter fanMode %i', (speedStep, fanMode) => {
    const acc = buildMatterAccessory(matterApi as never, 'uuid-1', device as never, {
      power: speedStep > 0, speedStep, mode: 'normal', direction: 'forward',
      lightPower: false, lightBrightness: 100,
    });
    expect(acc.clusters!.fanControl!.fanMode).toBe(fanMode);
  });

  it('sets fanModeSequence to OffLowMedHigh — no auto mode exists on this hardware', () => {
    const acc = buildMatterAccessory(matterApi as never, 'uuid-1', device as never, {
      power: true, speedStep: 1, mode: 'normal', direction: 'forward',
      lightPower: false, lightBrightness: 100,
    });
    expect(acc.clusters!.fanControl!.fanModeSequence).toBe(0); // OffLowMedHigh
  });

  it('sets every attribute Matter marks mandatory on the FanControl cluster', () => {
    const acc = buildMatterAccessory(matterApi as never, 'uuid-1', device as never, {
      power: true, speedStep: 2, mode: 'normal', direction: 'forward',
      lightPower: false, lightBrightness: 100,
    });
    for (const attr of MANDATORY_FAN_CONTROL_ATTRIBUTES) {
      expect(acc.clusters!.fanControl, `missing mandatory FanControl attribute "${attr}"`).toHaveProperty(attr);
    }
  });

  it('prefers the enum values exposed on matterApi.types over the hardcoded fallback', () => {
    const apiWithTypes = {
      ...matterApi,
      types: { FanControl: { FanMode: { Off: 10, Low: 11, Medium: 12, High: 13 }, FanModeSequence: { OffLowMedHigh: 99 } } },
    };
    const acc = buildMatterAccessory(apiWithTypes as never, 'uuid-1', device as never, {
      power: true, speedStep: 1, mode: 'normal', direction: 'forward',
      lightPower: false, lightBrightness: 100,
    });
    expect(acc.clusters!.fanControl!.fanMode).toBe(11);
    expect(acc.clusters!.fanControl!.fanModeSequence).toBe(99);
  });

  it('uses a UUID distinct from the HAP accessory UUID', () => {
    const a = buildMatterAccessory(matterApi as never, 'uuid-hap', device as never, {} as never);
    expect(a.UUID).not.toBe('uuid-hap');
  });

  it('derives the same UUID from the same device id, every time', () => {
    expect(matterUuid(device.id)).toBe(matterUuid(device.id));
    expect(matterUuid(device.id)).not.toBe(device.id);
  });

  it('wires onOff and fanControl handlers to the supplied callbacks', () => {
    const setPower = vi.fn();
    const setPercent = vi.fn();
    const acc = buildMatterAccessory(matterApi as never, 'uuid-1', device as never, {
      power: false, speedStep: 0, mode: 'normal', direction: 'forward',
      lightPower: false, lightBrightness: 100,
    }, { setPower, setPercent });

    acc.handlers!.onOff!.on!({}, undefined);
    acc.handlers!.onOff!.off!({}, undefined);
    expect(setPower).toHaveBeenNthCalledWith(1, true);
    expect(setPower).toHaveBeenNthCalledWith(2, false);

    acc.handlers!.fanControl!.percentSettingChange!({ percentSetting: 40, oldPercentSetting: 0 } as never, undefined);
    expect(setPercent).toHaveBeenCalledWith(40);

    acc.handlers!.fanControl!.fanModeChange!({ fanMode: 0, oldFanMode: 1 } as never, undefined);
    expect(setPower).toHaveBeenNthCalledWith(3, false);
  });
});
