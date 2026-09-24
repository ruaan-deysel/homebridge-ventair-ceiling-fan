import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  MatterAccessory,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { CeilingFanAccessory } from './accessory.js';
import { configuredDeviceIds, parseDevices, type VentairDevice } from './config.js';
import { MatterFanBridge, matterUuid } from './matter.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { FanStateManager } from './state.js';
import type { DiscoveredDevice } from './tuya/discovery.js';
import { discover } from './tuya/discovery.js';
import { TuyapiDevice } from './tuya/tuyapi.js';

export class HomebridgeVentairCeilingFan implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly matterAccessories: Map<string, MatterAccessory> = new Map();
  private readonly devices: VentairDevice[];
  /** IDs from the RAW config — see `removeStaleAccessories`. */
  private readonly configuredIds: string[];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.devices = parseDevices(config as { devices?: unknown }, log);
    this.configuredIds = configuredDeviceIds(config as { devices?: unknown });

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

  configureMatterAccessory(accessory: MatterAccessory): void {
    this.log.info('Loading Matter accessory from cache:', accessory.displayName);
    this.matterAccessories.set(accessory.UUID, accessory);
  }

  private isMatterEnabled(): boolean {
    return Boolean(this.api.isMatterEnabled?.() && this.api.matter);
  }

  async discoverDevices(): Promise<void> {
    // No discovery/connection attempt when nothing is configured, but stale cleanup
    // below must still run — otherwise clearing `devices` leaves dead tiles in HomeKit
    // forever.
    if (this.devices.length > 0) {
      // A discovery failure must not abort setup for devices with a static `ip` — same
      // per-device containment policy as parseDevices() and the setupDevice() try/catch below.
      let addresses: Map<string, DiscoveredDevice>;
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
      }
    }

    this.removeStaleAccessories();
    await this.removeStaleMatterAccessories();
  }

  private async setupDevice(device: VentairDevice, uuid: string, addresses: Map<string, DiscoveredDevice>): Promise<void> {
    const found = addresses.get(device.id);
    const ip = device.ip ?? found?.ip;
    // An explicitly configured version is the user's override and always wins. Otherwise
    // use what the device announced over UDP — a 3.4/3.5 fan constructed as 3.3 never
    // connects, which silently defeated the automatic discovery this plugin advertises.
    const version = device.version ?? found?.version ?? '3.3';

    if (!ip) {
      // Not fatal: tuyapi's own find() retries in the background.
      this.log.warn(`Could not discover an address for "${device.name}"; it will keep retrying.`);
    }

    const transport = new TuyapiDevice({ id: device.id, key: device.key, version, ip, label: device.name }, this.log);
    const stateManager = new FanStateManager(device, transport, this.log);

    const existing = this.accessories.get(uuid);
    if (existing) {
      this.log.info('Restoring accessory from cache:', existing.displayName);
      existing.context.device = device;
      new CeilingFanAccessory(this, existing, device, transport, stateManager);
    } else {
      this.log.info('Adding new ceiling fan:', device.name);
      const accessory = new this.api.platformAccessory(device.name, uuid, this.api.hap.Categories.FAN);
      accessory.context.device = device;
      new CeilingFanAccessory(this, accessory, device, transport, stateManager);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    if (this.isMatterEnabled()) {
      await this.registerMatter(device, stateManager);
    }
  }

  /**
   * Register the Matter representation of a fan when Matter is enabled on the bridge.
   * Both `isMatterEnabled()` and optional chaining guard `api.matter` access.
   *
   * Always (re)registers even when `configureMatterAccessory` already restored this UUID
   * from disk cache: cached Matter accessories carry no command `handlers` functions, so
   * `AccessoryManager.registerAccessory()` attaches the live handlers to the restored
   * endpoint in place while preserving cached cluster state.
   */
  private async registerMatter(device: VentairDevice, stateManager: FanStateManager): Promise<void> {
    if (!this.isMatterEnabled() || !this.api.matter) {
      return;
    }

    const bridge = new MatterFanBridge(this.api.matter, device, stateManager, this.log);
    const accessory = bridge.buildAccessory();

    this.log.info('Registering Matter fan:', device.name);
    await this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.matterAccessories.set(bridge.uuid, accessory);
  }

  /** Only run discovery if at least one device is missing an explicit address. */
  private async resolveAddresses(): Promise<Map<string, DiscoveredDevice>> {
    if (this.devices.every(d => d.ip)) {
      return new Map();
    }
    this.log.debug('Scanning for Tuya devices on the local network...');
    const found = await discover();
    this.log.debug(`Discovery found ${found.length} device(s).`);
    // The whole record, not just the address: the announced protocol version is the
    // other half of what a device needs to connect. See `setupDevice`.
    return new Map(found.map(d => [d.id, d]));
  }

  /**
   * Accessories dropped from config were previously left registered forever,
   * leaving dead tiles in the Home app.
   *
   * Keyed off the RAW configured IDs, never the parsed ones: `parseDevices` drops an
   * entry that fails validation, so keying off it meant one mistyped key didn't just
   * disable a fan — it unregistered it, discarding its room, scenes and automations
   * with no way for the plugin to put them back. An invalid entry is skipped from setup
   * but keeps its accessory; only an ID genuinely gone from config is removed.
   */
  private removeStaleAccessories(): void {
    const desired = new Set(this.configuredIds.map(id => this.api.hap.uuid.generate(id)));
    const stale = [...this.accessories.entries()]
      .filter(([uuid]) => !desired.has(uuid))
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
   * Same as `removeStaleAccessories`, for cached Matter accessories whose device IDs
   * were genuinely removed from `config.devices`. Keyed off `configuredIds` so a
   * validation error or a transient setup failure never destroys a cached Matter endpoint.
   */
  private async removeStaleMatterAccessories(): Promise<void> {
    if (!this.isMatterEnabled() || !this.api.matter) {
      return;
    }
    const desired = new Set(this.configuredIds.map(id => matterUuid(id)));
    const stale = [...this.matterAccessories.entries()]
      .filter(([uuid]) => !desired.has(uuid))
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
