export type DpValue = boolean | number | string;

/**
 * Numeric datapoint indices for the Ventair Skyfan DC (Tuya category `fs`).
 * Confirmed against live hardware in task #11 — see the design spec.
 */
export const DP = {
  power: '1',
  mode: '2',
  speed: '3',
  direction: '8',
  /** Present on the hardware but deliberately not implemented — see the spec. */
  countdown: '22',
  /** Unverified: no unit in this deployment has a light. */
  lightPower: '15',
  lightBrightness: '16',
} as const;

/**
 * Modes reachable over the LAN, confirmed by write probe both powered off and running:
 * the device accepts only "Normal" and "Sleep". Anything else — including the cloud's
 * "nature" and "smart" — comes back as "Sleep", consistent with the firmware resolving
 * the enum by index and defaulting unknowns to index 1.
 *
 * Kept as a plain string type, not a union: the cloud specification was already wrong
 * once, so unrecognised values are preserved rather than discarded.
 */
export const MODE_NORMAL = 'normal';
export const MODE_SLEEP = 'sleep';

export type FanMode = string;

/** The device expects capitalised mode strings, e.g. "Normal". */
export function toDeviceMode(mode: string): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1).toLowerCase();
}

export const DIRECTIONS = ['forward', 'reverse'] as const;
export type FanDirection = (typeof DIRECTIONS)[number];

/** The device reports speed 1-5; 0 is represented by the power datapoint being false. */
export const MAX_SPEED_STEP = 5;
const PERCENT_PER_STEP = 100 / MAX_SPEED_STEP;

/**
 * Devices with a light report brightness on their own scale. This deployment has no
 * light hardware, so the default is unverified — see the spec's light-support caveat.
 */
export const DEFAULT_BRIGHTNESS_SCALE = 100;

export interface DpsOptions {
  brightnessScale: number;
}

export interface FanState {
  power: boolean;
  mode: FanMode;
  speedStep: number;
  direction: FanDirection;
  lightPower: boolean;
  lightBrightness: number;
}

export function stepToPercent(step: number): number {
  return clamp(step, 0, MAX_SPEED_STEP) * PERCENT_PER_STEP;
}

export function percentToStep(percent: number): number {
  return clamp(Math.round(percent / PERCENT_PER_STEP), 0, MAX_SPEED_STEP);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Translate a raw device payload into partial state. Absent datapoints stay absent. */
export function toFanState(dps: Record<string, DpValue>, opts: DpsOptions): Partial<FanState> {
  const state: Partial<FanState> = {};

  const power = dps[DP.power];
  if (typeof power === 'boolean') {
    state.power = power;
  }
  const mode = dps[DP.mode];
  if (typeof mode === 'string') {
    // Lower-cased for internal comparison; unknown values pass through untouched.
    state.mode = mode.toLowerCase();
  }
  const speed = dps[DP.speed];
  if (typeof speed === 'number') {
    state.speedStep = clamp(speed, 0, MAX_SPEED_STEP);
  }
  const direction = dps[DP.direction];
  if (isDirection(direction)) {
    state.direction = direction;
  }
  const lightPower = dps[DP.lightPower];
  if (typeof lightPower === 'boolean') {
    state.lightPower = lightPower;
  }
  const lightBrightness = dps[DP.lightBrightness];
  if (typeof lightBrightness === 'number') {
    state.lightBrightness = Math.round((lightBrightness / opts.brightnessScale) * 100);
  }

  return state;
}

/** Translate a state patch into the datapoints to write. Only present keys are emitted. */
export function toDps(patch: Partial<FanState>, opts: DpsOptions): Record<string, DpValue> {
  const dps: Record<string, DpValue> = {};

  if (patch.power !== undefined) {
    dps[DP.power] = patch.power;
  }
  if (patch.mode !== undefined) {
    dps[DP.mode] = toDeviceMode(patch.mode);
  }
  if (patch.speedStep !== undefined) {
    dps[DP.speed] = clamp(patch.speedStep, 1, MAX_SPEED_STEP);
  }
  if (patch.direction !== undefined) {
    dps[DP.direction] = patch.direction;
  }
  if (patch.lightPower !== undefined) {
    dps[DP.lightPower] = patch.lightPower;
  }
  if (patch.lightBrightness !== undefined) {
    dps[DP.lightBrightness] = Math.round((patch.lightBrightness / 100) * opts.brightnessScale);
  }

  return dps;
}

function isDirection(v: DpValue | undefined): v is FanDirection {
  return typeof v === 'string' && (DIRECTIONS as readonly string[]).includes(v);
}
