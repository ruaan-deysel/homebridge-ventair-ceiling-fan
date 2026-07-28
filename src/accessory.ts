import type { PlatformAccessory } from 'homebridge';

import type { HomebridgeVentairCeilingFan } from './platform.js';
import type { VentairDevice } from './config.js';
import type { TuyaDevice } from './tuya/device.js';

/**
 * Placeholder — task #8 implements the real HomeKit service wiring.
 * Only stores its constructor arguments so platform.ts has something to
 * instantiate and test against.
 */
export class CeilingFanAccessory {
  constructor(
    private readonly platform: HomebridgeVentairCeilingFan,
    private readonly accessory: PlatformAccessory,
    private readonly device: VentairDevice,
    private readonly transport: TuyaDevice,
  ) {}
}
