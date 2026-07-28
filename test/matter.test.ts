import { describe, expect, it, vi } from 'vitest';
import { buildMatterAccessory, matterUuid } from '../src/matter.js';

const matterApi = {
  deviceTypes: { Fan: 'FanDevice' },
  clusterNames: { OnOff: 'onOff', FanControl: 'fanControl' },
};

const device = { id: 'a'.repeat(20), key: 'x'.repeat(16), name: 'Test Fan' };

describe('buildMatterAccessory', () => {
  it('declares a Fan device with onOff and fanControl clusters', () => {
    const acc = buildMatterAccessory(matterApi as never, 'uuid-1', device as never, {
      power: true, speedStep: 3, mode: 'normal', direction: 'forward',
      lightPower: false, lightBrightness: 100,
    });
    expect(acc.deviceType).toBe('FanDevice');
    expect(acc.clusters!.onOff!.onOff).toBe(true);
    expect(acc.clusters!.fanControl!.speedMax).toBe(5);
    expect(acc.clusters!.fanControl!.speedCurrent).toBe(3);
    expect(acc.clusters!.fanControl!.percentCurrent).toBe(60);
  });

  it('reports 0% and off when the fan is stopped', () => {
    const acc = buildMatterAccessory(matterApi as never, 'uuid-1', device as never, {
      power: false, speedStep: 0, mode: 'normal', direction: 'forward',
      lightPower: false, lightBrightness: 100,
    });
    expect(acc.clusters!.onOff!.onOff).toBe(false);
    expect(acc.clusters!.fanControl!.percentCurrent).toBe(0);
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
