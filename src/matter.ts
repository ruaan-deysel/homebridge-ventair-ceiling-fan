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
  setPower(on: boolean): Promise<void>;
  setPercent(percent: number): Promise<void>;
}

const noopCallbacks: MatterFanCallbacks = {
  setPower: async () => {},
  setPercent: async () => {},
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
    // Every handler here returns the callback's promise (never fire-and-forget). Homebridge's
    // Matter behaviors (e.g. HomebridgeOnOffServer.on(): `await registry.executeHandler(...)`
    // in node_modules/homebridge/dist/matter/behaviors/OnOffBehavior.js) await whatever this
    // handler returns before deciding whether to commit cluster state — a handler that returns
    // undefined makes that await resolve instantly, so Homebridge always committed the
    // requested state even when the underlying write to the fan failed or was still offline.
    // Returning the promise, combined with write() rethrowing after rollback (see below), lets
    // a failed write surface as a genuine Matter command failure instead of a silent success.
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
        // Non-Off modes must drive a speed, not just power — a Matter controller setting
        // fanMode to Low/Medium/High otherwise has no way to select speed. Mirrors the
        // step ranges fanModeForStep() maps Low/Medium/High from, so the two are consistent.
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

  /** Which `write()` call last touched each key of `state` — see `CeilingFanAccessory`'s
   * identical field for why a blind snapshot rollback on failure isn't safe. */
  private readonly keyVersion: Partial<Record<keyof FanState, number>> = {};
  private versionCounter = 0;

  /** Last value the DEVICE was actually observed to hold per key, fed only from inbound
   * updates — see `CeilingFanAccessory`'s identical field. Both surfaces must reconcile
   * a failed write the same way or HAP, Matter and the fan settle on three values. */
  private readonly lastConfirmed: Partial<FanState> = {};

  private readonly callbacks: MatterFanCallbacks = {
    // Both callbacks return write()'s promise (not fire-and-forget with `void`) — see the
    // comment on buildMatterAccessory()'s `handlers` for why that's required for Homebridge
    // to notice a failed write at all.
    setPower: on => {
      const speedStep = on && this.state.speedStep === 0 ? 1 : this.state.speedStep;
      return this.write(on ? { power: true, speedStep } : { power: false });
    },
    setPercent: percent => {
      const step = percentToStep(percent);
      return this.write(step === 0 ? { power: false } : { power: true, speedStep: step });
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
    this.transport.onDps(dps => {
      this.applyUpdate(dps).catch(error => {
        this.log.debug(`[${this.device.name}] Matter applyUpdate failed:`, error instanceof Error ? error.message : error);
      });
    });
  }

  /** The descriptor to pass to `matterApi.registerPlatformAccessories`. */
  buildAccessory(): MatterAccessory {
    return buildMatterAccessory(this.matterApi, this.hapUuid, this.device, this.state, this.callbacks);
  }

  private async write(patch: Partial<FanState>): Promise<void> {
    const version = ++this.versionCounter;
    (Object.keys(patch) as (keyof FanState)[]).forEach(key => {
      this.keyVersion[key] = version;
    });
    Object.assign(this.state, patch);
    try {
      await this.transport.set(toDps(patch, this.dpsOptions));
    } catch (error) {
      // Version-gated: only roll back keys nothing newer has touched since this write
      // started (see CeilingFanAccessory.reconcileAfterFailure for the full rationale —
      // an older write's failure must not stomp a newer write's already-applied state).
      await this.reconcileAfterFailure(patch, version);
      this.log.warn(`[${this.device.name}] Matter write failed:`, error instanceof Error ? error.message : error);
      // Push the reconciled state so Matter's local cache doesn't show the optimistic
      // patch that never actually reached the fan, then rethrow: the caller (the handler
      // returned to Homebridge in buildMatterAccessory()) must propagate this so
      // Homebridge's Matter behavior sees the failure and does not commit cluster state
      // that the device never received. Silently swallowing it here is exactly what let
      // an offline command still get a Matter success response.
      await this.pushState();
      throw error;
    }
    await this.pushState();
  }

  /** See CeilingFanAccessory.reconcileAfterFailure — same version-gated rollback,
   * rechecked before every assignment (ownership can change across the read), preferring
   * an authoritative device read, then the last confirmed device value, and leaving a key
   * alone entirely rather than restoring an optimistic snapshot the fan never received. */
  private async reconcileAfterFailure(patch: Partial<FanState>, version: number): Promise<void> {
    const ownedKeys = (Object.keys(patch) as (keyof FanState)[]).filter(key => this.keyVersion[key] === version);
    if (ownedKeys.length === 0) {
      return;
    }
    let authoritative: Partial<FanState> = {};
    try {
      authoritative = toFanState(await this.transport.get(), this.dpsOptions);
    } catch {
      // Device unreachable too — fall back to the last confirmed device value.
    }
    ownedKeys.forEach(key => {
      if (this.keyVersion[key] !== version) {
        return; // a newer write claimed this key while the read above was in flight
      }
      const source = key in authoritative ? authoritative : this.lastConfirmed;
      if (!(key in source)) {
        return; // nothing the device ever confirmed — leave the key as it stands
      }
      (this.state as Record<keyof FanState, unknown>)[key] = (source as Record<keyof FanState, unknown>)[key];
    });
  }

  private async applyUpdate(dps: Record<string, DpValue>): Promise<void> {
    const patch = toFanState(dps, this.dpsOptions);
    if (Object.keys(patch).length === 0) {
      return;
    }
    Object.assign(this.state, patch);
    // Inbound only — the device's own report, the fallback a failed write can trust.
    Object.assign(this.lastConfirmed, patch);
    await this.pushState();
  }

  private async pushState(): Promise<void> {
    const { onOff, fanControl } = matterClusters(this.matterApi, this.state);
    const results = await Promise.allSettled([
      this.matterApi.updateAccessoryState(this.uuid, this.matterApi.clusterNames.OnOff, onOff),
      this.matterApi.updateAccessoryState(this.uuid, this.matterApi.clusterNames.FanControl, fanControl),
    ]);
    const clusterNames = ['onOff', 'fanControl'] as const;
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        const error = result.reason;
        this.log.debug(
          `[${this.device.name}] Matter state push failed for ${clusterNames[i]}:`,
          error instanceof Error ? error.message : error,
        );
      }
    });
  }
}
