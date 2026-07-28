"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HomebridgeVentairCeilingFan = void 0;
const settings_1 = require("./settings");
const platformAccessory_1 = require("./platformAccessory");
/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
class HomebridgeVentairCeilingFan {
    log;
    config;
    api;
    Service;
    Characteristic;
    accessories = [];
    devices = [];
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;
        // Check if the configuration contains devices
        if (config.devices && Array.isArray(config.devices)) {
            this.devices = config.devices;
        }
        else {
            this.log.warn('No devices specified in the configuration.');
        }
        this.log.debug('Finished initializing platform:', this.config.name);
        this.api.on('didFinishLaunching', () => {
            log.debug('Executed didFinishLaunching callback');
            this.discoverDevices();
        });
    }
    configureAccessory(accessory) {
        this.log.info('Loading accessory from cache:', accessory.displayName);
        this.accessories.push(accessory);
    }
    discoverDevices() {
        for (const device of this.devices) {
            const uuid = this.api.hap.uuid.generate(device.id);
            const existingAccessory = this.accessories
                .find(accessory => accessory.UUID === uuid);
            if (existingAccessory) {
                this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
                new platformAccessory_1.CeilingFanAccessory(this, existingAccessory);
            }
            else if (!existingAccessory) {
                this.log.info('Adding new ceiling fan:', device.id, device.name, device.hasLight);
                const accessory = new this.api.platformAccessory(device.name, uuid, 3 /* Categories.FAN */);
                accessory.context.device = device;
                new platformAccessory_1.CeilingFanAccessory(this, accessory);
                this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            }
        }
    }
}
exports.HomebridgeVentairCeilingFan = HomebridgeVentairCeilingFan;
//# sourceMappingURL=platform.js.map