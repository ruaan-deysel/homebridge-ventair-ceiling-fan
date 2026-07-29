import { describe, expect, it, vi } from 'vitest';
import { DP } from '../src/dps.js';
import { buildMatterAccessory, matterUuid, MatterFanBridge } from '../src/matter.js';
import { FakeTuyaDevice } from '../src/tuya/device.js';
// A relative file-path import bypasses `homebridge`'s package.json `exports` restriction
// (which only exposes `./dist/index.js`) so this pulls in the REAL registry class
// Homebridge's own Matter behaviors use — not a hand-rolled stand-in. `HomebridgeOnOffServer.on()`
// (node_modules/homebridge/dist/matter/behaviors/OnOffBehavior.js) does
// `await registry.executeHandler(endpointId, 'onOff', 'on')` and only calls `super.on()` (which
// commits cluster state) if that resolves — this is the exact await/reject mechanism a
// fire-and-forget handler defeated.
import { BehaviorRegistry } from '../node_modules/homebridge/dist/matter/behaviors/BehaviorRegistry.js';

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

  it('maps Low/Medium/High fanModeChange onto a speed step, not just power', () => {
    const setPower = vi.fn();
    const setPercent = vi.fn();
    const acc = buildMatterAccessory(matterApi as never, 'uuid-1', device as never, {
      power: false, speedStep: 0, mode: 'normal', direction: 'forward',
      lightPower: false, lightBrightness: 100,
    }, { setPower, setPercent });

    // FALLBACK_FAN_MODE: Off 0, Low 1, Medium 2, High 3.
    acc.handlers!.fanControl!.fanModeChange!({ fanMode: 1, oldFanMode: 0 } as never, undefined); // Low
    acc.handlers!.fanControl!.fanModeChange!({ fanMode: 2, oldFanMode: 1 } as never, undefined); // Medium
    acc.handlers!.fanControl!.fanModeChange!({ fanMode: 3, oldFanMode: 2 } as never, undefined); // High

    expect(setPercent).toHaveBeenCalledTimes(3);
    expect(setPower).not.toHaveBeenCalled();
    const [low, medium, high] = setPercent.mock.calls.map(([p]) => p as number);
    expect(low).toBeGreaterThan(0);
    expect(medium).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(medium);
  });
});

describe('MatterFanBridge', () => {
  const bridgeDevice = { id: 'a'.repeat(20), key: 'k'.repeat(16), name: 'Bridge Fan' };

  function harness() {
    const matterApi = {
      deviceTypes: { Fan: 'FanDevice' },
      clusterNames: { OnOff: 'onOff', FanControl: 'fanControl' },
      updateAccessoryState: vi.fn().mockResolvedValue(undefined),
    };
    const log = { debug: vi.fn(), warn: vi.fn() };
    const transport = new FakeTuyaDevice();
    const bridge = new MatterFanBridge(matterApi as never, bridgeDevice as never, 'hap-uuid', transport, log as never);
    return { matterApi, log, transport, bridge };
  }

  it('rolls back optimistic state on a failed write before pushing to Matter', async () => {
    const { matterApi, log, transport, bridge } = harness();
    await transport.connect();
    // The device reports its own state first. Rollback restores that confirmed value —
    // never the failed write's optimistic snapshot, which under overlapping writes can
    // hold a value the fan never received.
    transport.emitDps({ [DP.power]: false });
    matterApi.updateAccessoryState.mockClear();
    vi.spyOn(transport, 'set').mockRejectedValue(new Error('device unreachable'));

    const acc = bridge.buildAccessory();
    // The handler must return write()'s promise and it must reject — this is what lets
    // Homebridge's Matter behavior see the failure and refuse to commit cluster state.
    await expect(acc.handlers!.onOff!.on!({}, undefined)).rejects.toThrow('device unreachable');

    expect(log.warn).toHaveBeenCalled();
    // Matter must have been pushed the rolled-back (still off) state, not the
    // optimistic on-state the failed write never actually achieved.
    const onOffCall = matterApi.updateAccessoryState.mock.calls.find(([, cluster]) => cluster === 'onOff');
    expect(onOffCall?.[2]).toEqual({ onOff: false });
    expect(bridge.buildAccessory().clusters!.onOff!.onOff).toBe(false);
  });

  it('pushes fanControl even when the onOff cluster update rejects', async () => {
    const { matterApi, log, transport, bridge } = harness();
    await transport.connect();
    matterApi.updateAccessoryState.mockImplementation((_uuid: string, cluster: string) =>
      cluster === 'onOff' ? Promise.reject(new Error('onOff failed')) : Promise.resolve(undefined),
    );

    const acc = bridge.buildAccessory();
    await acc.handlers!.onOff!.on!({}, undefined);

    await vi.waitFor(() => expect(matterApi.updateAccessoryState).toHaveBeenCalledWith(bridge.uuid, 'fanControl', expect.anything()));
    // Both clusters were attempted — a rejection on onOff did not short-circuit fanControl.
    const clustersCalled = matterApi.updateAccessoryState.mock.calls.map(([, cluster]) => cluster);
    expect(clustersCalled).toContain('onOff');
    expect(clustersCalled).toContain('fanControl');
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('onOff'), 'onOff failed');
  });

  it('an older write failing after a newer write already succeeded does not roll back the newer state', async () => {
    // Same race as CeilingFanAccessory's equivalent test: an older command is still
    // in flight when a newer one starts, applies its own optimistic state, and
    // succeeds — only then does the older command's write fail. Version-gating must
    // stop that failure from restoring the older write's own pre-write snapshot over
    // the newer, already-successful state.
    const { matterApi, transport, bridge } = harness();
    await transport.connect();

    let rejectOlder!: (error: unknown) => void;
    const olderSetPromise = new Promise<void>((_, reject) => {
      rejectOlder = reject;
    });
    vi.spyOn(transport, 'set').mockImplementationOnce(() => olderSetPromise);

    const acc = bridge.buildAccessory();
    const older = acc.handlers!.fanControl!.percentSettingChange!({ percentSetting: 20, oldPercentSetting: 0 } as never, undefined); // step 1, stuck in flight
    await acc.handlers!.fanControl!.percentSettingChange!({ percentSetting: 60, oldPercentSetting: 20 } as never, undefined); // step 3, completes first

    expect(bridge.buildAccessory().clusters!.fanControl!.percentCurrent).toBe(60);

    rejectOlder(new Error('device unreachable'));
    await expect(older).rejects.toThrow('device unreachable');

    // The newer, successful value must survive the older write's failure.
    expect(bridge.buildAccessory().clusters!.fanControl!.percentCurrent).toBe(60);
    const lastFanControlPush = matterApi.updateAccessoryState.mock.calls
      .filter(([, cluster]) => cluster === 'fanControl')
      .at(-1);
    expect(lastFanControlPush?.[2]).toMatchObject({ percentCurrent: 60 });
    // fails if reverted: an unconditional snapshot restore in write()'s catch pushes
    // percentCurrent back to 20 (or the pre-write 0) here instead of keeping 60.
  });

  it('does not restore a superseded write value the fan never received when reconciliation cannot read the device', async () => {
    // Mirror of the HAP-side test in accessory.test.ts — both surfaces must reconcile a
    // failed write identically, or HAP, Matter and the fan settle on three values.
    const { transport, bridge } = harness();
    await transport.connect();
    transport.emitDps({ [DP.power]: true, [DP.speed]: 5 });
    expect(bridge.buildAccessory().clusters!.fanControl!.percentCurrent).toBe(100);

    vi.spyOn(transport, 'get').mockRejectedValue(new Error('device unreachable'));
    vi.spyOn(transport, 'set')
      .mockImplementationOnce(() => new Promise<void>(() => {})) // step 1 — stuck in flight
      .mockImplementationOnce(() => new Promise<void>(() => {})) // step 2 — stuck in flight
      .mockRejectedValueOnce(new Error('device unreachable')); // step 3 — fails

    const acc = bridge.buildAccessory();
    void acc.handlers!.fanControl!.percentSettingChange!({ percentSetting: 20, oldPercentSetting: 100 } as never, undefined);
    void acc.handlers!.fanControl!.percentSettingChange!({ percentSetting: 40, oldPercentSetting: 20 } as never, undefined);
    await expect(
      acc.handlers!.fanControl!.percentSettingChange!({ percentSetting: 60, oldPercentSetting: 40 } as never, undefined),
    ).rejects.toThrow('device unreachable');

    // 40% is the superseded middle command's optimistic value — the fan never saw it.
    expect(bridge.buildAccessory().clusters!.fanControl!.percentCurrent).toBe(100);
    // fails if reverted: the `previous[key]` fallback restores 40 here.
  });

  it('propagates a disconnected-transport write failure through the real Homebridge registry.executeHandler path', async () => {
    // Exercises the actual mechanism Homebridge's Matter behaviors rely on, not a mock
    // that resolves regardless: registry.executeHandler() is exactly what
    // HomebridgeOnOffServer.on() awaits before committing cluster state. Before this fix,
    // the handler returned `undefined` synchronously, so this await resolved instantly and
    // Homebridge committed the "on" state even though the write below never reached the fan.
    const { transport, bridge } = harness();
    vi.spyOn(transport, 'set').mockRejectedValue(new Error('device disconnected'));

    const acc = bridge.buildAccessory();
    const registry = new BehaviorRegistry(new Map([[acc.UUID, acc]]));
    registry.registerHandler(acc.UUID, 'onOff', 'on', acc.handlers!.onOff!.on!);

    await expect(registry.executeHandler(acc.UUID, 'onOff', 'on')).rejects.toThrow('device disconnected');
  });

  it('catches a rejected applyUpdate from onDps instead of an unhandled rejection', async () => {
    const { matterApi, log, transport } = harness();
    matterApi.updateAccessoryState.mockImplementation(() => {
      throw new Error('sync boom');
    });
    // FakeTuyaDevice.emitDps drives the onDps listener MatterFanBridge registered in its
    // constructor — the same fire-and-forget path a real device push would take.
    transport.emitDps({ 1: true });

    await vi.waitFor(() => expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('applyUpdate failed'),
      'sync boom',
    ));
  });
});
