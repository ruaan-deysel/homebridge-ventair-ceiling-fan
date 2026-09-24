import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { VentairDevice } from './config.js';
import { type FanState, MODE_SLEEP, stepToPercent } from './dps.js';
import type { HomebridgeVentairCeilingFan } from './platform.js';
import { PLUGIN_VERSION } from './settings.js';
import { FanStateManager } from './state.js';
import type { TuyaDevice } from './tuya/device.js';

export class CeilingFanAccessory {
  private readonly fan: Service;
  private readonly light?: Service;
  private sleepSwitch?: Service;

  constructor(
    private readonly platform: HomebridgeVentairCeilingFan,
    private readonly accessory: PlatformAccessory,
    private readonly device: VentairDevice,
    private readonly transport: TuyaDevice,
    private readonly stateManager: FanStateManager = new FanStateManager(device, transport, platform.log),
  ) {
    const { Characteristic, Service: S } = this.platform;

    this.accessory.getService(S.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Ventair')
      .setCharacteristic(Characteristic.Model, 'Skyfan DC')
      .setCharacteristic(Characteristic.SerialNumber, device.id)
      .setCharacteristic(Characteristic.FirmwareRevision, PLUGIN_VERSION);

    this.fan = this.accessory.getService(S.Fanv2) ?? this.accessory.addService(S.Fanv2);
    this.fan.setCharacteristic(Characteristic.Name, device.name);
    this.fan.setCharacteristic(Characteristic.ConfiguredName, device.name);

    this.fan.getCharacteristic(Characteristic.Active)
      .onSet(v => this.setActive(v))
      .onGet(() => this.read(() => (this.stateManager.state.power ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE)));

    this.fan.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 20 })
      .onSet(v => this.setSpeed(v))
      .onGet(() => this.read(() => (this.stateManager.state.power ? stepToPercent(this.stateManager.state.speedStep) : 0)));

    this.fan.getCharacteristic(Characteristic.RotationDirection)
      .onSet(v => this.setDirection(v))
      .onGet(() => this.read(() => (
        this.stateManager.state.direction === 'forward'
          ? Characteristic.RotationDirection.CLOCKWISE
          : Characteristic.RotationDirection.COUNTER_CLOCKWISE
      )));

    if (device.hasLight) {
      const lightName = `${device.name} Light`;
      this.light = this.accessory.getService(S.Lightbulb) ?? this.accessory.addService(S.Lightbulb, lightName);
      this.light.setCharacteristic(Characteristic.Name, lightName);
      this.light.setCharacteristic(Characteristic.ConfiguredName, lightName);

      this.light.getCharacteristic(Characteristic.On)
        .onSet(v => this.runWrite(() => this.stateManager.setLightPower(v as boolean)))
        .onGet(() => this.read(() => this.stateManager.state.lightPower));

      this.light.getCharacteristic(Characteristic.Brightness)
        .onSet(v => this.runWrite(() => this.stateManager.setLightBrightness(v as number)))
        .onGet(() => this.read(() => this.stateManager.state.lightBrightness));
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
      // One switch, covering Sleep only: on writes Sleep, off writes Normal.
      //
      // The hardware does NOT have exactly two modes — a fan driven from the Smart Life
      // app reported mode "eco" (2026-07-29). What the earlier probe established is
      // narrower: writing `nature`/`smart` over the LAN silently lands on Sleep, so those
      // two are not worth exposing. Whether `Eco` is writable over the LAN is untested
      // (a fan allows one LAN session, so it cannot be probed while this plugin holds it).
      //
      // Consequence to keep in mind: a fan sitting in eco shows this switch OFF, and
      // toggling it off writes Normal, taking the fan out of eco with no way back from
      // HomeKit. Inbound eco itself is preserved — see `toFanState`.
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
        // runWrite() delegates to FanStateManager.setSleepMode(), which rolls back and
        // rethrows on failure — syncModeSwitch() runs via the stateManager onChange listener
        // on success, and the HapStatusError rejection propagates to HAP, reverting the
        // switch in the Home app.
        .onSet(v => this.runWrite(() => this.stateManager.setSleepMode(Boolean(v))))
        .onGet(() => this.read(() => this.stateManager.state.mode === MODE_SLEEP));
    } else {
      // exposeModeSwitches turned off after being on: the cached accessory still
      // carries the switch (possibly more than one, pre-fix) — drop all of them
      // instead of leaving dead tiles in the Home app.
      for (const extra of cachedSwitches) {
        this.accessory.removeService(extra);
      }
    }

    this.stateManager.onChange(patch => this.pushToCharacteristics(patch));

    // Deferred a tick: kicks off the real connection without racing synchronous
    // readers of `transport.connected` that run right after construction.
    queueMicrotask(() => void this.transport.connect());
  }

  /** HomeKit should show "No Response" rather than a stale value we can't vouch for. */
  private read<T>(fn: () => T): T {
    if (!this.stateManager.connected) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return fn();
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const on = value === this.platform.Characteristic.Active.ACTIVE;
    await this.runWrite(() => this.stateManager.setPower(on));
  }

  private async setSpeed(value: CharacteristicValue): Promise<void> {
    await this.runWrite(() => this.stateManager.setSpeedPercent(value as number));
  }

  private async setDirection(value: CharacteristicValue): Promise<void> {
    const direction = value === this.platform.Characteristic.RotationDirection.CLOCKWISE ? 'forward' : 'reverse';
    await this.runWrite(() => this.stateManager.setDirection(direction));
  }

  private syncModeSwitch(): void {
    this.sleepSwitch?.updateCharacteristic(
      this.platform.Characteristic.On,
      this.stateManager.state.mode === MODE_SLEEP,
    );
  }

  private async runWrite(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  private pushToCharacteristics(patch: Partial<FanState>): void {
    const { Characteristic } = this.platform;
    const state = this.stateManager.state;
    if (patch.power !== undefined || patch.speedStep !== undefined) {
      this.fan.updateCharacteristic(Characteristic.Active, state.power ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
      this.fan.updateCharacteristic(Characteristic.RotationSpeed, state.power ? stepToPercent(state.speedStep) : 0);
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
