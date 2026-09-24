import type { Logging } from 'homebridge';

import type { VentairDevice } from './config.js';
import {
  DEFAULT_BRIGHTNESS_SCALE,
  type DpValue,
  type FanDirection,
  type FanState,
  MODE_NORMAL,
  MODE_SLEEP,
  percentToStep,
  toDps,
  toFanState,
} from './dps.js';
import type { TuyaDevice } from './tuya/device.js';

export type StateChangeListener = (patch: Partial<FanState>, state: Readonly<FanState>) => void;

/**
 * Single source of truth for one ceiling fan's state across both HomeKit (HAP) and
 * Matter. Owns the optimistic state snapshot, per-key write versioning, last
 * device-confirmed values, and version-gated rollback on failed writes so neither
 * protocol surface ever maintains a duplicate state tracker.
 */
export class FanStateManager {
  readonly state: FanState = {
    power: false,
    mode: MODE_NORMAL,
    speedStep: 0,
    direction: 'forward',
    lightPower: false,
    lightBrightness: 100,
  };

  private readonly dpsOptions = { brightnessScale: DEFAULT_BRIGHTNESS_SCALE };

  /**
   * Which `write()` call last touched each key of `state`. Lets a failed write's
   * rollback tell "nobody has touched this key since me" apart from "a newer write
   * already landed here" — see `write()`/`reconcileAfterFailure`.
   */
  private readonly keyVersion: Partial<Record<keyof FanState, number>> = {};
  private versionCounter = 0;

  /**
   * Last value the DEVICE was actually observed to hold for each key — fed only from
   * inbound updates (`applyUpdate`, i.e. the transport's onDps and the initial refresh),
   * never from an optimistic write. That distinction is the whole point: a failed write's
   * own pre-write snapshot can contain a value from an earlier write that never reached
   * the fan, so restoring it publishes a state the hardware never held.
   */
  private readonly lastConfirmed: Partial<FanState> = {};

  private readonly listeners = new Set<StateChangeListener>();

  constructor(
    private readonly device: Pick<VentairDevice, 'name'>,
    private readonly transport: TuyaDevice,
    private readonly log: Pick<Logging, 'debug' | 'warn'>,
  ) {
    this.transport.onDps(dps => this.applyUpdate(dps));
    this.transport.onConnected(() => void this.refresh());
    this.transport.onDisconnected(() => this.log.debug(`[${this.device.name}] disconnected`));
  }

  get connected(): boolean {
    return this.transport.connected;
  }

  onChange(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async setPower(on: boolean): Promise<void> {
    if (!on) {
      await this.write({ power: false });
      return;
    }
    // Coming on from a standstill needs a speed, or the fan turns on and does nothing.
    const speedStep = this.state.speedStep > 0 ? this.state.speedStep : 1;
    await this.write({ power: true, speedStep });
  }

  async setSpeedPercent(percent: number): Promise<void> {
    const step = percentToStep(percent);
    if (step === 0) {
      await this.write({ power: false });
      return;
    }
    await this.write({ power: true, speedStep: step });
  }

  async setDirection(direction: FanDirection): Promise<void> {
    await this.write({ direction });
  }

  async setSleepMode(sleep: boolean): Promise<void> {
    await this.write({ mode: sleep ? MODE_SLEEP : MODE_NORMAL });
  }

  async setLightPower(lightPower: boolean): Promise<void> {
    await this.write({ lightPower });
  }

  async setLightBrightness(lightBrightness: boolean | number): Promise<void> {
    await this.write({ lightBrightness: Number(lightBrightness) });
  }

  /**
   * Optimistic local update, one `set()` call per datapoint. Rolled back on failure —
   * but only for keys this write still "owns" (nothing newer has touched them since):
   * two concurrent writes can be in flight together (e.g. a queued speed change and an
   * unrelated direction change), and if the OLDER one fails after the NEWER one has
   * already applied its own optimistic state and entered the queue, blindly restoring
   * this write's snapshot would stomp the newer command's value even though the newer
   * write is going to succeed. See `reconcileAfterFailure` for the version-gated rollback.
   */
  async write(patch: Partial<FanState>): Promise<void> {
    const version = ++this.versionCounter;
    (Object.keys(patch) as (keyof FanState)[]).forEach(key => {
      this.keyVersion[key] = version;
    });
    Object.assign(this.state, patch);
    try {
      await this.transport.set(toDps(patch, this.dpsOptions));
    } catch (error) {
      await this.reconcileAfterFailure(patch, version);
      this.log.warn(`[${this.device.name}] write failed:`, error instanceof Error ? error.message : error);
      throw error;
    }
    this.notify(patch);
  }

  /**
   * A failed write leaves the true device state ambiguous for the keys it touched — the
   * transport may have partially applied the patch before failing. Reconciling a key is
   * only safe while nothing newer has touched it, and ownership can change at ANY await,
   * including the authoritative read below — so it is rechecked immediately before every
   * assignment, not just once up front. Order of preference per key: the authoritative
   * device read, then the last value the device was actually seen to hold
   * (`lastConfirmed`), then nothing at all. Never this write's own optimistic snapshot:
   * under overlapping writes that snapshot can hold a superseded value the fan never
   * received, and publishing it invents a state that never existed.
   */
  private async reconcileAfterFailure(patch: Partial<FanState>, version: number): Promise<void> {
    const ownedKeys = (Object.keys(patch) as (keyof FanState)[]).filter(key => this.keyVersion[key] === version);
    if (ownedKeys.length === 0) {
      return; // every key this write touched has since been superseded by a newer write
    }
    let authoritative: Partial<FanState> = {};
    try {
      authoritative = toFanState(await this.transport.get() as Record<string, DpValue>, this.dpsOptions);
    } catch {
      // Device unreachable too — fall back to the last confirmed device value.
    }
    const reconciled = {} as Partial<FanState>;
    ownedKeys.forEach(key => {
      if (this.keyVersion[key] !== version) {
        return; // a newer write claimed this key while the read above was in flight
      }
      const source = key in authoritative ? authoritative : this.lastConfirmed;
      if (!(key in source)) {
        return; // nothing the device ever confirmed — leave callers showing what they have
      }
      const value = (source as Record<keyof FanState, unknown>)[key];
      (this.state as Record<keyof FanState, unknown>)[key] = value;
      (reconciled as Record<keyof FanState, unknown>)[key] = value;
    });
    if (Object.keys(reconciled).length > 0) {
      this.notify(reconciled);
    }
  }

  private async refresh(): Promise<void> {
    try {
      this.applyUpdate(await this.transport.get());
    } catch (error) {
      this.log.debug(`[${this.device.name}] initial refresh failed:`, error instanceof Error ? error.message : error);
    }
  }

  private applyUpdate(dps: Record<string, unknown>): void {
    const patch = toFanState(dps as Record<string, DpValue>, this.dpsOptions);
    if (Object.keys(patch).length === 0) {
      return;
    }
    Object.assign(this.state, patch);
    // Inbound only: this is the device telling us what it holds, which is exactly what
    // a failed write's reconciliation may need to fall back on.
    Object.assign(this.lastConfirmed, patch);
    // Debug, not info — eight fans pushing state at info level floods the log.
    this.log.debug(`[${this.device.name}] update:`, JSON.stringify(patch));
    this.notify(patch);
  }

  private notify(patch: Partial<FanState>): void {
    for (const listener of this.listeners) {
      try {
        listener(patch, this.state);
      } catch (error) {
        this.log.debug(
          `[${this.device.name}] state listener threw:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}
