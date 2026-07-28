import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { CeilingFanAccessory } from './accessory.js';
import { parseDevices, type VentairDevice } from './config.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { discover } from './tuya/discovery.js';
import { TuyapiDevice } from './tuya/tuyapi.js';

export class HomebridgeVentairCeilingFan implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory> = new Map();
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
    }

    this.removeStaleAccessories();
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
}
