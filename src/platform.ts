import type { API, Characteristic, DynamicPlatformPlugin, Logging, MatterAccessory, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { CeilingFanAccessory } from './accessory.js';
import { parseDevices, type VentairDevice } from './config.js';
import { MatterFanBridge } from './matter.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { discover } from './tuya/discovery.js';
import { TuyapiDevice } from './tuya/tuyapi.js';

export class HomebridgeVentairCeilingFan implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly matterAccessories: Map<string, MatterAccessory> = new Map();
  private readonly discoveredCacheUUIDs: string[] = [];
  private readonly discoveredMatterUUIDs: string[] = [];
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
    if (this.devices.length === 0) {
      return;
    }

    const addresses = await this.resolveAddresses();

    for (const device of this.devices) {
      const uuid = this.api.hap.uuid.generate(device.id);
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

      this.discoveredCacheUUIDs.push(uuid);

      if (device.exposeMatter) {
        await this.registerMatter(device, transport);
      }
    }

    this.removeStaleAccessories();
    this.removeStaleMatterAccessories();
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

    if (!this.matterAccessories.has(bridge.uuid)) {
      this.log.info('Adding new Matter fan:', device.name);
      await this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    this.matterAccessories.set(bridge.uuid, accessory);
    this.discoveredMatterUUIDs.push(bridge.uuid);
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

  /** Same as `removeStaleAccessories`, for devices that had Matter turned off or removed. */
  private removeStaleMatterAccessories(): void {
    if (!this.api.isMatterEnabled() || !this.api.matter) {
      return;
    }
    const stale = [...this.matterAccessories.entries()]
      .filter(([uuid]) => !this.discoveredMatterUUIDs.includes(uuid))
      .map(([, accessory]) => accessory);

    if (stale.length === 0) {
      return;
    }

    for (const accessory of stale) {
      this.log.info('Removing Matter accessory no longer in config:', accessory.displayName);
      this.matterAccessories.delete(accessory.UUID);
    }
    void this.api.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
  }
}
