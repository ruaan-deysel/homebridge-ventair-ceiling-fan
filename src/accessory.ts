import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { VentairDevice } from './config.js';
import { DEFAULT_BRIGHTNESS_SCALE, MODE_NORMAL, MODE_SLEEP, type FanState, percentToStep, stepToPercent, toDps, toFanState } from './dps.js';
import type { HomebridgeVentairCeilingFan } from './platform.js';
import type { TuyaDevice } from './tuya/device.js';

export class CeilingFanAccessory {
  private readonly fan: Service;
  private readonly light?: Service;
  private sleepSwitch?: Service;

  private readonly state: FanState = {
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

  constructor(
    private readonly platform: HomebridgeVentairCeilingFan,
    private readonly accessory: PlatformAccessory,
    private readonly device: VentairDevice,
    private readonly transport: TuyaDevice,
  ) {
    const { Characteristic, Service: S } = this.platform;

    this.accessory.getService(S.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Ventair')
      .setCharacteristic(Characteristic.Model, 'Skyfan DC')
      .setCharacteristic(Characteristic.SerialNumber, device.id)
      .setCharacteristic(Characteristic.FirmwareRevision, '2.0.0');

    this.fan = this.accessory.getService(S.Fanv2) ?? this.accessory.addService(S.Fanv2);
    this.fan.setCharacteristic(Characteristic.Name, device.name);
    this.fan.setCharacteristic(Characteristic.ConfiguredName, device.name);

    this.fan.getCharacteristic(Characteristic.Active)
      .onSet(v => this.setActive(v))
      .onGet(() => this.read(() => (this.state.power ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE)));

    this.fan.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 20 })
      .onSet(v => this.setSpeed(v))
      .onGet(() => this.read(() => (this.state.power ? stepToPercent(this.state.speedStep) : 0)));

    this.fan.getCharacteristic(Characteristic.RotationDirection)
      .onSet(v => this.setDirection(v))
      .onGet(() => this.read(() => (
        this.state.direction === 'forward'
          ? Characteristic.RotationDirection.CLOCKWISE
          : Characteristic.RotationDirection.COUNTER_CLOCKWISE
      )));

    if (device.hasLight) {
      const lightName = `${device.name} Light`;
      this.light = this.accessory.getService(S.Lightbulb) ?? this.accessory.addService(S.Lightbulb, lightName);
      this.light.setCharacteristic(Characteristic.Name, lightName);
      this.light.setCharacteristic(Characteristic.ConfiguredName, lightName);

      this.light.getCharacteristic(Characteristic.On)
        .onSet(v => this.write({ lightPower: v as boolean }))
        .onGet(() => this.read(() => this.state.lightPower));

      this.light.getCharacteristic(Characteristic.Brightness)
        .onSet(v => this.write({ lightBrightness: v as number }))
        .onGet(() => this.read(() => this.state.lightBrightness));
    }

    const sleepSubtype = 'sleep';
    // Every Switch service currently on the accessory, keyed only by UUID (not
    // subtype). Cached accessories from before the subtype fix carry a bare,
    // subtype-less Switch; a naive getServiceById(subtype) lookup misses it and
    // adds a second one alongside it forever. Reconciling the whole set on every
    // launch — preferring a subtyped match, otherwise adopting the legacy one,
    // and removing any others — is idempotent and self-heals that state.
    const cachedSwitches = this.accessory.services.filter(s => s.UUID === this.accessory.getService(S.Switch)?.UUID);

    if (device.exposeModeSwitches) {
      // Hardware has exactly two reachable modes (Normal, Sleep) — one switch covers it.
      // On writes Sleep, off writes Normal. Do not add Nature/Smart switches: writing
      // anything other than Normal/Sleep silently lands on Sleep on the real hardware.
      const label = 'Sleep';
      this.sleepSwitch = cachedSwitches.find(s => s.subtype === sleepSubtype)
        ?? cachedSwitches[0] // adopt a legacy subtype-less Switch rather than orphaning it
        ?? this.accessory.addService(S.Switch, label, sleepSubtype);
      for (const extra of cachedSwitches) {
        if (extra !== this.sleepSwitch) {
          this.accessory.removeService(extra);
        }
      }
      this.sleepSwitch.setCharacteristic(Characteristic.Name, label);
      this.sleepSwitch.setCharacteristic(Characteristic.ConfiguredName, `${device.name} Sleep`);
      this.sleepSwitch.getCharacteristic(Characteristic.On)
        // write() rolls back and rethrows a HapStatusError on failure — syncModeSwitch()
        // only runs on success, and the rejection propagates to HAP, which reverts the
        // switch in the Home app. No .catch() needed here.
        .onSet(v => this.write({ mode: v ? MODE_SLEEP : MODE_NORMAL }).then(() => this.syncModeSwitch()))
        .onGet(() => this.read(() => this.state.mode === MODE_SLEEP));
    } else {
      // exposeModeSwitches turned off after being on: the cached accessory still
      // carries the switch (possibly more than one, pre-fix) — drop all of them
      // instead of leaving dead tiles in the Home app.
      for (const extra of cachedSwitches) {
        this.accessory.removeService(extra);
      }
    }

    this.transport.onDps(dps => this.applyUpdate(dps));
    this.transport.onConnected(() => void this.refresh());
    this.transport.onDisconnected(() => this.platform.log.debug(`[${device.name}] disconnected`));

    // Deferred a tick: kicks off the real connection without racing synchronous
    // readers of `transport.connected` that run right after construction.
    queueMicrotask(() => void this.transport.connect());
  }

  /** HomeKit should show "No Response" rather than a stale value we can't vouch for. */
  private read<T>(fn: () => T): T {
    if (!this.transport.connected) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return fn();
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const on = value === this.platform.Characteristic.Active.ACTIVE;
    if (!on) {
      await this.write({ power: false });
      this.fan.updateCharacteristic(this.platform.Characteristic.RotationSpeed, 0);
      return;
    }
    // Coming on from a standstill needs a speed, or the fan turns on and does nothing.
    const speedStep = this.state.speedStep > 0 ? this.state.speedStep : 1;
    await this.write({ power: true, speedStep });
    this.fan.updateCharacteristic(this.platform.Characteristic.RotationSpeed, stepToPercent(speedStep));
  }

  private async setSpeed(value: CharacteristicValue): Promise<void> {
    const step = percentToStep(value as number);
    if (step === 0) {
      await this.write({ power: false });
      this.fan.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.INACTIVE);
      return;
    }
    await this.write({ power: true, speedStep: step });
    this.fan.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.ACTIVE);
  }

  private async setDirection(value: CharacteristicValue): Promise<void> {
    const direction = value === this.platform.Characteristic.RotationDirection.CLOCKWISE ? 'forward' : 'reverse';
    await this.write({ direction });
  }

  private syncModeSwitch(): void {
    this.sleepSwitch?.updateCharacteristic(
      this.platform.Characteristic.On,
      this.state.mode === MODE_SLEEP,
    );
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
  private async write(patch: Partial<FanState>): Promise<void> {
    const version = ++this.versionCounter;
    (Object.keys(patch) as (keyof FanState)[]).forEach(key => {
      this.keyVersion[key] = version;
    });
    Object.assign(this.state, patch);
    try {
      await this.transport.set(toDps(patch, this.dpsOptions));
    } catch (error) {
      await this.reconcileAfterFailure(patch, version);
      this.platform.log.warn(`[${this.device.name}] write failed:`, error instanceof Error ? error.message : error);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
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
      authoritative = toFanState(await this.transport.get() as Record<string, string | number | boolean>, this.dpsOptions);
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
        return; // nothing the device ever confirmed — leave HomeKit showing what it has
      }
      const value = (source as Record<keyof FanState, unknown>)[key];
      (this.state as Record<keyof FanState, unknown>)[key] = value;
      (reconciled as Record<keyof FanState, unknown>)[key] = value;
    });
    if (Object.keys(reconciled).length > 0) {
      this.pushToCharacteristics(reconciled);
    }
  }

  private async refresh(): Promise<void> {
    try {
      this.applyUpdate(await this.transport.get());
    } catch (error) {
      this.platform.log.debug(`[${this.device.name}] initial refresh failed:`, error instanceof Error ? error.message : error);
    }
  }

  private applyUpdate(dps: Record<string, unknown>): void {
    const patch = toFanState(dps as Record<string, string | number | boolean>, this.dpsOptions);
    if (Object.keys(patch).length === 0) {
      return;
    }
    Object.assign(this.state, patch);
    // Inbound only: this is the device telling us what it holds, which is exactly what
    // a failed write's reconciliation may need to fall back on.
    Object.assign(this.lastConfirmed, patch);
    // Debug, not info — eight fans pushing state at info level floods the log.
    this.platform.log.debug(`[${this.device.name}] update:`, JSON.stringify(patch));
    this.pushToCharacteristics(patch);
  }

  private pushToCharacteristics(patch: Partial<FanState>): void {
    const { Characteristic } = this.platform;
    if (patch.power !== undefined) {
      this.fan.updateCharacteristic(Characteristic.Active, patch.power ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
    }
    if (patch.speedStep !== undefined || patch.power !== undefined) {
      this.fan.updateCharacteristic(Characteristic.RotationSpeed, this.state.power ? stepToPercent(this.state.speedStep) : 0);
    }
    if (patch.direction !== undefined) {
      this.fan.updateCharacteristic(
        Characteristic.RotationDirection,
        patch.direction === 'forward' ? Characteristic.RotationDirection.CLOCKWISE : Characteristic.RotationDirection.COUNTER_CLOCKWISE,
      );
    }
    if (patch.mode !== undefined) {
      this.syncModeSwitch();
    }
    if (this.light && patch.lightPower !== undefined) {
      this.light.updateCharacteristic(Characteristic.On, patch.lightPower);
    }
    if (this.light && patch.lightBrightness !== undefined) {
      this.light.updateCharacteristic(Characteristic.Brightness, patch.lightBrightness);
    }
  }
}
