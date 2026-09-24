import { createHash } from 'node:crypto';
import type { Logging, MatterAccessory, MatterAPI } from 'homebridge';

import type { VentairDevice } from './config.js';
import { type FanState, MODE_SLEEP, stepToPercent } from './dps.js';
import { PLUGIN_VERSION } from './settings.js';
import type { FanStateManager } from './state.js';

type MatterAccessoryPart = NonNullable<MatterAccessory['parts']>[number];

/**
 * Fallback Matter `FanControl.FanMode`/`FanModeSequence` enum values (see @matter/types),
 * used only when `matterApi.types` isn't available — e.g. in unit tests, where the mocked
 * `matterApi` provides just `deviceTypes`/`clusterNames`. On a real bridge, `matterApi.types`
 * is preferred (see `fanModeForStep`/`fanModeSequence` below) so this plugin tracks whatever
 * matter.js version Homebridge is running, rather than hardcoding numbers that could drift.
 *
 * `OffLowMedHigh` is the only sequence used: these fans have 5 discrete speeds and no
 * auto/smart mode, so any `...Auto` sequence would misrepresent the device.
 */
const FALLBACK_FAN_MODE = { Off: 0, Low: 1, Medium: 2, High: 3 } as const;
const FALLBACK_FAN_MODE_SEQUENCE_OFF_LOW_MED_HIGH = 0;

const MATTER_MIN_LIGHT_LEVEL = 1;
const MATTER_MAX_LIGHT_LEVEL = 254;

/**
 * Matter requires `fanModeSequence` (conformance "M") — resolve it off `matterApi.types`
 * when exposed, else fall back to the spec value for `OffLowMedHigh`.
 */
function fanModeSequence(matterApi: MatterAPI): number {
  return matterApi.types?.FanControl?.FanModeSequence?.OffLowMedHigh ?? FALLBACK_FAN_MODE_SEQUENCE_OFF_LOW_MED_HIGH;
}

/**
 * Matter requires `fanMode` (conformance "M"). These fans have no auto mode, so it is
 * derived from the effective speed step: 0 → Off, 1-2 → Low, 3 → Medium, 4-5 → High.
 */
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

/**
 * Convert a 0-100% brightness value to Matter's lighting `LevelControl` range (1-254).
 * Matter's `Lighting` feature requires `minLevel: 1` and `maxLevel: 254`.
 */
export function percentToMatterLevel(percent: number): number {
  const clamped = Math.min(100, Math.max(0, percent));
  if (clamped <= 1) {
    return MATTER_MIN_LIGHT_LEVEL;
  }
  return Math.min(
    MATTER_MAX_LIGHT_LEVEL,
    Math.max(MATTER_MIN_LIGHT_LEVEL, Math.round(((clamped - 1) / 99) * (MATTER_MAX_LIGHT_LEVEL - MATTER_MIN_LIGHT_LEVEL)) + MATTER_MIN_LIGHT_LEVEL),
  );
}

/**
 * Convert a Matter `LevelControl` level (1-254) back to 0-100% brightness.
 */
export function matterLevelToPercent(level: number): number {
  if (level <= 0) {
    return 0;
  }
  const clamped = Math.min(MATTER_MAX_LIGHT_LEVEL, Math.max(MATTER_MIN_LIGHT_LEVEL, level));
  return Math.round(((clamped - MATTER_MIN_LIGHT_LEVEL) / (MATTER_MAX_LIGHT_LEVEL - MATTER_MIN_LIGHT_LEVEL)) * 99) + 1;
}

export interface MatterFanCallbacks {
  setPower(on: boolean): Promise<void>;
  setPercent(percent: number): Promise<void>;
  setSleepMode(sleep: boolean): Promise<void>;
  setLightPower(on: boolean): Promise<void>;
  setLightBrightness(percent: number): Promise<void>;
}

const noopCallbacks: MatterFanCallbacks = {
  setPower: async () => {},
  setPercent: async () => {},
  setSleepMode: async () => {},
  setLightPower: async () => {},
  setLightBrightness: async () => {},
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
 */
export function matterFanClusters(
  matterApi: MatterAPI,
  state: Readonly<FanState>,
): { onOff: { onOff: boolean }; fanControl: Record<string, number> } {
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

export function matterLightClusters(
  state: Readonly<FanState>,
): { onOff: { onOff: boolean }; levelControl: { currentLevel: number; minLevel: number; maxLevel: number } } {
  return {
    onOff: { onOff: state.lightPower },
    levelControl: {
      currentLevel: percentToMatterLevel(state.lightBrightness),
      minLevel: MATTER_MIN_LIGHT_LEVEL,
      maxLevel: MATTER_MAX_LIGHT_LEVEL,
    },
  };
}

export function matterSleepClusters(state: Readonly<FanState>): { onOff: { onOff: boolean } } {
  return {
    onOff: { onOff: state.mode === MODE_SLEEP },
  };
}

/**
 * Build the Matter accessory descriptor for one fan, wiring `handlers` to `callbacks` so
 * Matter controllers can drive the fan, optional dimmable light, and optional Sleep switch.
 * Pure otherwise: given the same state it always returns the same descriptor.
 */
export function buildMatterAccessory(
  matterApi: MatterAPI,
  device: VentairDevice,
  state: Readonly<FanState>,
  callbacks: MatterFanCallbacks = noopCallbacks,
): MatterAccessory {
  const parts: MatterAccessoryPart[] = [];

  if (device.hasLight && matterApi.deviceTypes.DimmableLight) {
    parts.push({
      id: 'light',
      displayName: `${device.name} Light`,
      deviceType: matterApi.deviceTypes.DimmableLight,
      clusters: matterLightClusters(state),
      handlers: {
        onOff: {
          on: () => callbacks.setLightPower(true),
          off: () => callbacks.setLightPower(false),
        },
        levelControl: {
          moveToLevel: ({ level }: { level: number }) => callbacks.setLightBrightness(matterLevelToPercent(level)),
          moveToLevelWithOnOff: async ({ level }: { level: number }) => {
            if (level <= MATTER_MIN_LIGHT_LEVEL) {
              await callbacks.setLightPower(false);
              return;
            }
            await callbacks.setLightBrightness(matterLevelToPercent(level));
            await callbacks.setLightPower(true);
          },
        },
      },
    });
  }

  const switchDeviceType = matterApi.deviceTypes.OnOffSwitch ?? matterApi.deviceTypes.OnOffOutlet;
  if (device.exposeModeSwitches && switchDeviceType) {
    parts.push({
      id: 'sleep',
      displayName: `${device.name} Sleep`,
      deviceType: switchDeviceType,
      clusters: matterSleepClusters(state),
      handlers: {
        onOff: {
          on: () => callbacks.setSleepMode(true),
          off: () => callbacks.setSleepMode(false),
        },
      },
    });
  }

  return {
    UUID: matterUuid(device.id),
    displayName: device.name,
    deviceType: matterApi.deviceTypes.Fan,
    manufacturer: 'Ventair',
    model: 'Skyfan DC',
    serialNumber: device.id,
    firmwareRevision: PLUGIN_VERSION,
    context: { device },
    clusters: matterFanClusters(matterApi, state),
    ...(parts.length > 0 ? { parts } : {}),
    handlers: {
      onOff: {
        on: () => callbacks.setPower(true),
        off: () => callbacks.setPower(false),
      },
      fanControl: {
        percentSettingChange: ({ percentSetting }) => {
          if (percentSetting !== null && percentSetting !== undefined) {
            return callbacks.setPercent(percentSetting);
          }
          return undefined;
        },
        fanModeChange: ({ fanMode }) => {
          const mode = matterApi.types?.FanControl?.FanMode ?? FALLBACK_FAN_MODE;
          if (fanMode === mode.Off) {
            return callbacks.setPower(false);
          }
          const step = fanMode === mode.Low ? 1 : fanMode === mode.Medium ? 3 : fanMode === mode.High ? 5 : undefined;
          if (step === undefined) {
            return callbacks.setPower(true);
          }
          return callbacks.setPercent(stepToPercent(step));
        },
      },
    },
  };
}

/**
 * Thin Matter protocol adapter for one ceiling fan. Consumes the shared `FanStateManager`
 * rather than owning any state, versioning, or rollback logic of its own — eliminating the
 * duplicate optimistic-state path that previously caused HAP/Matter state divergence.
 */
export class MatterFanBridge {
  readonly uuid: string;

  private readonly callbacks: MatterFanCallbacks = {
    setPower: on => this.runCommand(() => this.stateManager.setPower(on)),
    setPercent: percent => this.runCommand(() => this.stateManager.setSpeedPercent(percent)),
    setSleepMode: sleep => this.runCommand(() => this.stateManager.setSleepMode(sleep)),
    setLightPower: on => this.runCommand(() => this.stateManager.setLightPower(on)),
    setLightBrightness: percent => this.runCommand(() => this.stateManager.setLightBrightness(percent)),
  };

  constructor(
    private readonly matterApi: MatterAPI,
    private readonly device: VentairDevice,
    private readonly stateManager: FanStateManager,
    private readonly log: Pick<Logging, 'debug' | 'warn'>,
  ) {
    this.uuid = matterUuid(device.id);
    this.stateManager.onChange(() => {
      void this.pushState();
    });
  }

  /** The descriptor to pass to `matterApi.registerPlatformAccessories`. */
  buildAccessory(): MatterAccessory {
    return buildMatterAccessory(this.matterApi, this.device, this.stateManager.state, this.callbacks);
  }

  private async runCommand(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      await this.pushState();
      throw error;
    }
    await this.pushState();
  }

  async pushState(): Promise<void> {
    const state = this.stateManager.state;
    const { onOff, fanControl } = matterFanClusters(this.matterApi, state);
    const onOffCluster = this.matterApi.clusterNames?.OnOff ?? 'onOff';
    const fanControlCluster = this.matterApi.clusterNames?.FanControl ?? 'fanControl';
    const levelControlCluster = this.matterApi.clusterNames?.LevelControl ?? 'levelControl';

    const updates: { label: string; promise: Promise<void> }[] = [
      {
        label: 'onOff',
        promise: this.matterApi.updateAccessoryState(this.uuid, onOffCluster, onOff),
      },
      {
        label: 'fanControl',
        promise: this.matterApi.updateAccessoryState(this.uuid, fanControlCluster, fanControl),
      },
    ];

    if (this.device.hasLight && this.matterApi.deviceTypes.DimmableLight) {
      const light = matterLightClusters(state);
      updates.push(
        {
          label: 'light.onOff',
          promise: this.matterApi.updateAccessoryState(this.uuid, onOffCluster, light.onOff, 'light'),
        },
        {
          label: 'light.levelControl',
          promise: this.matterApi.updateAccessoryState(this.uuid, levelControlCluster, light.levelControl, 'light'),
        },
      );
    }

    const switchDeviceType = this.matterApi.deviceTypes.OnOffSwitch ?? this.matterApi.deviceTypes.OnOffOutlet;
    if (this.device.exposeModeSwitches && switchDeviceType) {
      const sleep = matterSleepClusters(state);
      updates.push({
        label: 'sleep.onOff',
        promise: this.matterApi.updateAccessoryState(this.uuid, onOffCluster, sleep.onOff, 'sleep'),
      });
    }

    const results = await Promise.allSettled(updates.map(u => u.promise));
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        const error = result.reason;
        this.log.debug(
          `[${this.device.name}] Matter state push failed for ${updates[i].label}:`,
          error instanceof Error ? error.message : error,
        );
      }
    });
  }
}
