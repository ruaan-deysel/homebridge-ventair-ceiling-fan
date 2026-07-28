import { createHash } from 'node:crypto';

import type { Logging } from 'homebridge';
import type { MatterAccessory, MatterAPI } from 'homebridge';

import type { VentairDevice } from './config.js';
import { DEFAULT_BRIGHTNESS_SCALE, type DpValue, type FanState, MODE_NORMAL, percentToStep, stepToPercent, toDps, toFanState } from './dps.js';
import type { TuyaDevice } from './tuya/device.js';

/**
 * Fallback Matter `FanControl.FanMode`/`FanModeSequence` enum values (see @matter/types),
 * used only when `matterApi.types` isn't available — e.g. in unit tests, where the mocked
 * `matterApi` provides just `deviceTypes`/`clusterNames`. On a real bridge, `matterApi.types`
 * is preferred (see `fanModeEnum`/`fanModeSequenceEnum` below) so this plugin tracks whatever
 * matter.js version Homebridge is running, rather than hardcoding numbers that could drift.
 *
 * `OffLowMedHigh` is the only sequence used: these fans have 5 discrete speeds and no
 * auto/smart mode (confirmed on hardware — only Normal/Sleep exist), so any `...Auto`
 * sequence would misrepresent the device.
 */
const FALLBACK_FAN_MODE = { Off: 0, Low: 1, Medium: 2, High: 3 } as const;
const FALLBACK_FAN_MODE_SEQUENCE_OFF_LOW_MED_HIGH = 0;

/** Matter requires `fanModeSequence` (conformance "M") — resolve it off `matterApi.types`
 * when exposed, else fall back to the spec value for `OffLowMedHigh`. */
function fanModeSequence(matterApi: MatterAPI): number {
  return matterApi.types?.FanControl?.FanModeSequence?.OffLowMedHigh ?? FALLBACK_FAN_MODE_SEQUENCE_OFF_LOW_MED_HIGH;
}

/** Matter requires `fanMode` (conformance "M"). These fans have no auto mode, so it is
 * derived from the effective speed step: 0 → Off, 1-2 → Low, 3 → Medium, 4-5 → High. */
function fanModeForStep(matterApi: MatterAPI, step: number): number {
  const mode = matterApi.types?.FanControl?.FanMode ?? FALLBACK_FAN_MODE;
  if (step <= 0) {
    return mode.Off;
  }
  if (step <= 2) {
    return mode.Low;
  }
  if (step === 3) {
    return mode.Medium;
  }
  return mode.High;
}

export interface MatterFanCallbacks {
  setPower(on: boolean): void;
  setPercent(percent: number): void;
}

const noopCallbacks: MatterFanCallbacks = {
  setPower: () => {},
  setPercent: () => {},
};

/**
 * Deterministic UUID for the Matter twin of a device. Seeded with a `matter:` prefix so
 * it can never collide with the HAP UUID, which Homebridge derives from the bare device id.
 */
export function matterUuid(deviceId: string): string {
  const hash = createHash('sha1').update(`matter:${deviceId}`).digest('hex');
  return [hash.slice(0, 8), hash.slice(8, 12), hash.slice(12, 16), hash.slice(16, 20), hash.slice(20, 32)].join('-');
}

/**
 * Convert a `FanState` snapshot into Matter's onOff + fanControl cluster attributes.
 * Uses `dps.ts`'s `stepToPercent` exclusively for the step-to-percent conversion — no new
 * speed arithmetic. Speed 0 is represented by power being off, matching the hardware.
 *
 * Matter's FanControl cluster has no rotation-direction attribute, so `direction` is not
 * represented here; it stays HAP-only (see README).
 *
 * Only sets the FanControl base attributes (`fanMode`, `fanModeSequence`, `percentCurrent`,
 * `percentSetting`) — these are unconditionally mandatory ("M" conformance) and always
 * allowed. `speedMax`/`speedCurrent`/`speedSetting` are deliberately NOT set: they require
 * the optional "Speed" (SPD) feature on the FanControl cluster, and Homebridge's Matter
 * plugin API has no way to declare cluster features when registering an accessory (checked
 * `MatterAccessory`/`MatterAccessoryPart` in `homebridge`'s `dist/matter/types.d.ts` — no
 * `features` field; and `deviceTypes.Fan` always builds `FanDeviceDefinition` with the base
 * `FanControlServer`, which matter.js instantiates with no `.with(Feature...)` — see
 * `@matter/node`'s `devices/fan.d.ts` and `behaviors/fan-control/FanControlServer.d.ts`).
 * Setting SPD-gated attributes on a cluster that doesn't declare SPD is a conformance
 * violation that rolls back the *entire* state update, so they're dropped rather than sent
 * speculatively. `percentCurrent`/`percentSetting` already fully express this 1-5-speed fan
 * (20/40/60/80/100%), so nothing is lost.
 */
function matterClusters(matterApi: MatterAPI, state: FanState): { onOff: { onOff: boolean }; fanControl: Record<string, number> } {
  const speedCurrent = state.power ? state.speedStep : 0;
  const percentCurrent = state.power ? stepToPercent(state.speedStep) : 0;
  return {
    onOff: { onOff: state.power },
    fanControl: {
      fanMode: fanModeForStep(matterApi, speedCurrent),
      fanModeSequence: fanModeSequence(matterApi),
      percentCurrent,
      percentSetting: percentCurrent,
    },
  };
}

/**
 * Build the Matter accessory descriptor for one fan, wiring `handlers` to `callbacks` so
 * Home-app-equivalent Matter controllers can drive the device. Pure otherwise: given the
 * same state it always returns the same descriptor.
 */
export function buildMatterAccessory(
  matterApi: MatterAPI,
  hapUuid: string,
  device: VentairDevice,
  state: FanState,
  callbacks: MatterFanCallbacks = noopCallbacks,
): MatterAccessory {
  void hapUuid; // not part of the Matter UUID — see matterUuid(); kept for callers to diff against.

  return {
    UUID: matterUuid(device.id),
    displayName: device.name,
    deviceType: matterApi.deviceTypes.Fan,
    manufacturer: 'Ventair',
    model: 'Skyfan DC',
    serialNumber: device.id,
    context: {},
    clusters: matterClusters(matterApi, state),
    handlers: {
      onOff: {
        on: () => callbacks.setPower(true),
        off: () => callbacks.setPower(false),
      },
      fanControl: {
        percentSettingChange: ({ percentSetting }) => {
          if (percentSetting !== null && percentSetting !== undefined) {
            callbacks.setPercent(percentSetting);
          }
        },
        fanModeChange: ({ fanMode }) => callbacks.setPower(fanMode !== FALLBACK_FAN_MODE.Off),
      },
    },
  };
}

/**
 * Owns the Matter-side lifecycle for one fan: builds the initial accessory, wires its
 * handlers to write through the shared Tuya transport, and pushes device-initiated updates
 * back to Matter via `updateAccessoryState`. Mirrors `CeilingFanAccessory`'s HAP-side
 * responsibilities but stays independent of it — Matter exposure is opt-in per device and
 * must not affect the HAP accessory if disabled.
 */
export class MatterFanBridge {
  readonly uuid: string;

  private state: FanState = {
    power: false,
    mode: MODE_NORMAL,
    speedStep: 0,
    direction: 'forward',
    lightPower: false,
    lightBrightness: 100,
  };

  private readonly dpsOptions = { brightnessScale: DEFAULT_BRIGHTNESS_SCALE };

  private readonly callbacks: MatterFanCallbacks = {
    setPower: on => {
      const speedStep = on && this.state.speedStep === 0 ? 1 : this.state.speedStep;
      void this.write(on ? { power: true, speedStep } : { power: false });
    },
    setPercent: percent => {
      const step = percentToStep(percent);
      void this.write(step === 0 ? { power: false } : { power: true, speedStep: step });
    },
  };

  constructor(
    private readonly matterApi: MatterAPI,
    private readonly device: VentairDevice,
    private readonly hapUuid: string,
    private readonly transport: TuyaDevice,
    private readonly log: Pick<Logging, 'debug' | 'warn'>,
  ) {
    this.uuid = matterUuid(device.id);
    this.transport.onDps(dps => void this.applyUpdate(dps));
  }

  /** The descriptor to pass to `matterApi.registerPlatformAccessories`. */
  buildAccessory(): MatterAccessory {
    return buildMatterAccessory(this.matterApi, this.hapUuid, this.device, this.state, this.callbacks);
  }

  private async write(patch: Partial<FanState>): Promise<void> {
    Object.assign(this.state, patch);
    try {
      await this.transport.set(toDps(patch, this.dpsOptions));
    } catch (error) {
      this.log.warn(`[${this.device.name}] Matter write failed:`, error instanceof Error ? error.message : error);
    }
    await this.pushState();
  }

  private async applyUpdate(dps: Record<string, DpValue>): Promise<void> {
    const patch = toFanState(dps, this.dpsOptions);
    if (Object.keys(patch).length === 0) {
      return;
    }
    Object.assign(this.state, patch);
    await this.pushState();
  }

  private async pushState(): Promise<void> {
    const { onOff, fanControl } = matterClusters(this.matterApi, this.state);
    try {
      await this.matterApi.updateAccessoryState(this.uuid, this.matterApi.clusterNames.OnOff, onOff);
      await this.matterApi.updateAccessoryState(this.uuid, this.matterApi.clusterNames.FanControl, fanControl);
    } catch (error) {
      this.log.debug(`[${this.device.name}] Matter state push failed:`, error instanceof Error ? error.message : error);
    }
  }
}
