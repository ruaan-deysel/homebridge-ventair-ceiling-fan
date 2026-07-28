import type { API, Characteristic, DynamicPlatformPlugin, Logging, MatterAccessory, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { CeilingFanAccessory } from './accessory.js';
import { parseDevices, type VentairDevice } from './config.js';
import { MatterFanBridge, matterUuid } from './matter.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { discover } from './tuya/discovery.js';
import { TuyapiDevice } from './tuya/tuyapi.js';

export class HomebridgeVentairCeilingFan implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly matterAccessories: Map<string, MatterAccessory> = new Map();
  private readonly discoveredCacheUUIDs: string[] = [];
  private readonly devices: VentairDevice[];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.devices = parseDevices(config as { devices?: unknown }, log);

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      // Rejections here would otherwise be an unhandled promise on the bridge.
      this.discoverDevices().catch(error => {
        this.log.error('Device setup failed:', error instanceof Error ? error.message : error);
      });
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  /** The Matter twin of `configureAccessory` — tracks cached Matter accessories on startup. */
  configureMatterAccessory(accessory: MatterAccessory): void {
    this.log.info('Loading Matter accessory from cache:', accessory.displayName);
    this.matterAccessories.set(accessory.UUID, accessory);
  }

  async discoverDevices(): Promise<void> {
    // Computed from valid configuration BEFORE any setup is attempted — never from
    // "which UUIDs made it through registerMatter() successfully". A Matter UUID that
    // enters this set is preserved by removeStaleMatterAccessories() below even if this
    // device's setup rejects (transient API-readiness hiccup, startup race, etc.). The
    // previous version only recorded a UUID as discovered AFTER registerMatter()
    // succeeded, so a transient failure on a configured, cached Matter fan fell through
    // to the "not discovered this run" bucket and removeStaleMatterAccessories()
    // permanently unregistered it — destroying the user's cached Matter endpoint state
    // for what was often just a one-off startup error.
    const desiredMatterUUIDs = this.devices.filter(d => d.exposeMatter).map(d => matterUuid(d.id));

    // No discovery/connection attempt when nothing is configured, but stale cleanup
    // below must still run — otherwise clearing `devices` leaves dead tiles in HomeKit
    // forever, since discoveredCacheUUIDs stays empty and every previously-cached
    // accessory looks "stale" but is never actually removed.
    if (this.devices.length > 0) {
      // A discovery failure must not abort setup for devices with a static `ip` — same
      // per-device containment policy as parseDevices() and the setupDevice() try/catch below.
      let addresses: Map<string, string>;
      try {
        addresses = await this.resolveAddresses();
      } catch (error) {
        this.log.warn('Device discovery failed:', error instanceof Error ? error.message : error);
        addresses = new Map();
      }

      for (const device of this.devices) {
        const uuid = this.api.hap.uuid.generate(device.id);
        // One bad fan must cost one fan, not the bridge — same philosophy as parseDevices.
        // uuid is still recorded below even on failure, so a transient setup error doesn't
        // also make removeStaleAccessories() delete the accessory from the Home app.
        try {
          await this.setupDevice(device, uuid, addresses);
        } catch (error) {
          this.log.error(`Setup failed for "${device.name}":`, error instanceof Error ? error.message : error);
        }
        this.discoveredCacheUUIDs.push(uuid);
      }
    }

    this.removeStaleAccessories();
    await this.removeStaleMatterAccessories(desiredMatterUUIDs);
  }

  private async setupDevice(device: VentairDevice, uuid: string, addresses: Map<string, string>): Promise<void> {
    const ip = device.ip ?? addresses.get(device.id);

    if (!ip) {
      // Not fatal: tuyapi's own find() retries in the background.
      this.log.warn(`Could not discover an address for "${device.name}"; it will keep retrying.`);
    }

    const transport = new TuyapiDevice({ id: device.id, key: device.key, version: device.version, ip }, this.log);

    const existing = this.accessories.get(uuid);
    if (existing) {
      this.log.info('Restoring accessory from cache:', existing.displayName);
      existing.context.device = device;
      new CeilingFanAccessory(this, existing, device, transport);
    } else {
      this.log.info('Adding new ceiling fan:', device.name);
      const accessory = new this.api.platformAccessory(device.name, uuid, this.api.hap.Categories.FAN);
      accessory.context.device = device;
      new CeilingFanAccessory(this, accessory, device, transport);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    if (device.exposeMatter) {
      await this.registerMatter(device, transport);
    }
  }

  /**
   * Matter is beta and off by default — `api.matter` throws if accessed on a bridge
   * without Matter configured, so both `isMatterEnabled()` and optional chaining guard
   * every access.
   */
  private async registerMatter(device: VentairDevice, transport: TuyapiDevice): Promise<void> {
    if (!this.api.isMatterEnabled() || !this.api.matter) {
      this.log.warn(`Matter requested for "${device.name}" but Matter is not enabled on this bridge; skipping.`);
      return;
    }

    const hapUuid = this.api.hap.uuid.generate(device.id);
    const bridge = new MatterFanBridge(this.api.matter, device, hapUuid, transport, this.log);
    const accessory = bridge.buildAccessory();

    // Always (re)register, even when `configureMatterAccessory` already restored this
    // UUID into `matterAccessories` from the on-disk cache. That restore path passes a
    // deserialized accessory with no handlers/getState — the Matter manager's own
    // deserializer explicitly documents this: "handlers and getState are not restored
    // from cache - plugins must provide these" (node_modules/homebridge/dist/matter/
    // BaseMatterManager.js, deserializeMatterAccessory()). The live handlers only exist
    // on the accessory just built by MatterFanBridge here. Registering it is also safe
    // on restart specifically: AccessoryManager.registerAccessory() only throws
    // "already registered" against the in-memory session `accessories` map, which is
    // fresh per bridge process — the on-disk cache alone does not populate it — and it
    // restores cached cluster state onto the newly-registered accessory via
    // `restoreCachedState()` (node_modules/homebridge/dist/matter/server/
    // AccessoryManager.js, registerAccessory(), lines ~33-40). Skipping this call is
    // exactly what left Matter accessories inert after a restart.
    this.log.info('Registering Matter fan:', device.name);
    await this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.matterAccessories.set(bridge.uuid, accessory);
  }

  /** Only run discovery if at least one device is missing an explicit address. */
  private async resolveAddresses(): Promise<Map<string, string>> {
    if (this.devices.every(d => d.ip)) {
      return new Map();
    }
    this.log.debug('Scanning for Tuya devices on the local network...');
    const found = await discover();
    this.log.debug(`Discovery found ${found.length} device(s).`);
    return new Map(found.map(d => [d.id, d.ip]));
  }

  /**
   * Accessories dropped from config were previously left registered forever,
   * leaving dead tiles in the Home app.
   */
  private removeStaleAccessories(): void {
    const stale = [...this.accessories.entries()]
      .filter(([uuid]) => !this.discoveredCacheUUIDs.includes(uuid))
      .map(([, accessory]) => accessory);

    if (stale.length === 0) {
      return;
    }

    for (const accessory of stale) {
      this.log.info('Removing accessory no longer in config:', accessory.displayName);
      this.accessories.delete(accessory.UUID);
    }
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
  }

  /**
   * Same as `removeStaleAccessories`, for devices that had Matter turned off or removed.
   * `desiredMatterUUIDs` is computed by the caller from valid configuration alone — not
   * from which devices' setup happened to succeed this run — so a transient setup
   * failure on a still-configured Matter fan can never look "stale" here.
   */
  private async removeStaleMatterAccessories(desiredMatterUUIDs: string[]): Promise<void> {
    if (!this.api.isMatterEnabled() || !this.api.matter) {
      return;
    }
    const stale = [...this.matterAccessories.entries()]
      .filter(([uuid]) => !desiredMatterUUIDs.includes(uuid))
      .map(([, accessory]) => accessory);

    if (stale.length === 0) {
      return;
    }

    for (const accessory of stale) {
      this.log.info('Removing Matter accessory no longer in config:', accessory.displayName);
      this.matterAccessories.delete(accessory.UUID);
    }
    try {
      await this.api.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    } catch (error) {
      this.log.warn('Removing stale Matter accessories failed:', error instanceof Error ? error.message : error);
    }
  }
}
