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
    if (device.exposeModeSwitches) {
      // Hardware has exactly two reachable modes (Normal, Sleep) — one switch covers it.
      // On writes Sleep, off writes Normal. Do not add Nature/Smart switches: writing
      // anything other than Normal/Sleep silently lands on Sleep on the real hardware.
      // Switch is a generic HAP service type, so a stable subtype is required — on
      // restart Homebridge restores the accessory with this service already attached,
      // and a bare addService() throws "same UUID ... without a unique subtype".
      const label = 'Sleep';
      this.sleepSwitch = this.accessory.getServiceById(S.Switch, sleepSubtype)
        ?? this.accessory.addService(S.Switch, label, sleepSubtype);
      this.sleepSwitch.setCharacteristic(Characteristic.Name, label);
      this.sleepSwitch.setCharacteristic(Characteristic.ConfiguredName, `${device.name} Sleep`);
      this.sleepSwitch.getCharacteristic(Characteristic.On)
        .onSet(v => this.write({ mode: v ? MODE_SLEEP : MODE_NORMAL }).then(() => this.syncModeSwitch()))
        .onGet(() => this.read(() => this.state.mode === MODE_SLEEP));
    } else {
      // exposeModeSwitches turned off after being on: the cached accessory still
      // carries the switch — drop it instead of leaving a dead tile forever.
      const stale = this.accessory.getServiceById(S.Switch, sleepSubtype);
      if (stale) {
        this.accessory.removeService(stale);
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

  /** Optimistic local update plus one batched write. */
  private async write(patch: Partial<FanState>): Promise<void> {
    Object.assign(this.state, patch);
    try {
      await this.transport.set(toDps(patch, this.dpsOptions));
    } catch (error) {
      this.platform.log.warn(`[${this.device.name}] write failed:`, error instanceof Error ? error.message : error);
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
    // Debug, not info — eight fans pushing state at info level floods the log.
    this.platform.log.debug(`[${this.device.name}] update:`, JSON.stringify(patch));

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
