import { PlatformAccessory } from 'homebridge';
import { HomebridgeVentairCeilingFan } from './platform';
import TuyAPI from 'tuyapi';
export declare class CeilingFanAccessory {
    private readonly platform;
    private readonly accessory;
    private fanService;
    private lightService?;
    private state;
    constructor(platform: HomebridgeVentairCeilingFan, accessory: PlatformAccessory);
    connect(device: TuyAPI): Promise<void>;
    fetchInitialState(device: TuyAPI): Promise<void>;
}
