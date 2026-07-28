import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { HomebridgeVentairCeilingFan } from './platform';
import TuyAPI from 'tuyapi';

type TuyaDeviceData = {
  dps: {
    [key: string]: boolean | number | string;
  };
};

export class CeilingFanAccessory {
  private fanService: Service;
  private lightService?: Service;

  private state = {
    fanStatus: 0,
    rotationDirection: 0,
    rotationSpeedStep: 0,
    swingMode: 0,
    lightOn: false,
    lightBrightness: 100,
  };

  constructor(
    private readonly platform: HomebridgeVentairCeilingFan,
    private readonly accessory: PlatformAccessory,
  ) {
    const device = new TuyAPI({
      id: accessory.context.device.id,
      key: accessory.context.device.key,
      ip: accessory.context.device.ip,
      version: accessory.context.device.version,
      issueRefreshOnConnect: true,
    });

    device.on('disconnected', () => {
      this.platform.log.info('Disconnected... Try to connect');
      this.connect(device);
    });
    device.on('error', error => {
      this.platform.log.info('Error :', error);
      this.platform.log.info('Try to connect');
      this.connect(device);
    });

    // Information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ventair')
      .setCharacteristic(this.platform.Characteristic.Model, 'Ceiling Fan')
      .setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.id);

    // Fan
    this.fanService = this.accessory.getService(this.platform.Service.Fanv2) || this.accessory.addService(this.platform.Service.Fanv2);
    this.fanService.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    // Fan state
    this.fanService.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(async (value: CharacteristicValue) => {
        this.state.fanStatus = value as number;
        await device.set({
          dps: 1,
          set: this.state.fanStatus === this.platform.Characteristic.Active.ACTIVE,
          shouldWaitForResponse: false,
        });
        if (this.state.fanStatus === this.platform.Characteristic.Active.INACTIVE) {
          this.state.rotationSpeedStep = 0;
          this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, 0);
        } else if (this.state.rotationSpeedStep === 0) {
          this.state.rotationSpeedStep = 1;
          await device.set({ dps: 3, set: 1, shouldWaitForResponse: false });
          this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, 20);
        }
      })
      .onGet(() => this.state.fanStatus);

    // Fan rotation
    this.fanService.getCharacteristic(this.platform.Characteristic.RotationDirection)
      .onSet(async (value: CharacteristicValue) => {
        this.state.rotationDirection = value as number;
        await device.set({
          dps: 8,
          set: this.state.rotationDirection === this.platform.Characteristic.RotationDirection.CLOCKWISE ? 'forward' : 'reverse',
          shouldWaitForResponse: false,
        });
      })
      .onGet(() => this.state.rotationDirection);

    // Fan speed
    this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({
        minStep: 20,  // 100% / 5 steps = 20%
        minValue: 0,
        maxValue: 100
      })
      .onSet(async (value: CharacteristicValue) => {
        const speedPercent = value as number;
        const speedStep = Math.round(speedPercent / 20);  // Convert percent to 0-5 range

        if (speedStep !== this.state.rotationSpeedStep) {
          this.state.rotationSpeedStep = speedStep;

          if (speedStep === 0) {
            // Turn off the fan
            this.state.fanStatus = this.platform.Characteristic.Active.INACTIVE;
            await device.set({ dps: 1, set: false, shouldWaitForResponse: false });
            this.fanService.updateCharacteristic(this.platform.Characteristic.Active, this.state.fanStatus);
          } else {
            // Turn on the fan if it's not already on
            if (this.state.fanStatus === this.platform.Characteristic.Active.INACTIVE) {
              this.state.fanStatus = this.platform.Characteristic.Active.ACTIVE;
              await device.set({ dps: 1, set: true, shouldWaitForResponse: false });
              this.fanService.updateCharacteristic(this.platform.Characteristic.Active, this.state.fanStatus);
            }
            // Set the fan speed
            await device.set({ dps: 3, set: speedStep, shouldWaitForResponse: false });
          }
        }
      })
      .onGet(() => {
        // Convert 0-5 step to 0-100 percent
        return this.state.rotationSpeedStep * 20;
      });

    // Swing mode (representing fan modes)
    this.fanService.getCharacteristic(this.platform.Characteristic.SwingMode)
      .onSet(async (value: CharacteristicValue) => {
        const swingMode = value as number;
        this.state.swingMode = swingMode;

        let mode: string;
        switch (swingMode) {
          case this.platform.Characteristic.SwingMode.SWING_ENABLED:
            mode = 'nature';
            break;
          case this.platform.Characteristic.SwingMode.SWING_DISABLED:
            mode = 'smart';
            break;
          default:
            mode = 'sleep';
        }

        await device.set({
          dps: 2,
          set: mode,
          shouldWaitForResponse: false,
        });
      })
      .onGet(() => this.state.swingMode);

    if (accessory.context.device.hasLight) {
      // Fan Light
      this.lightService = this.accessory.getService(this.platform.Service.Lightbulb)
        || this.accessory.addService(this.platform.Service.Lightbulb);
      this.lightService.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);
      this.lightService.getCharacteristic(this.platform.Characteristic.On)
        .onSet(async (value: CharacteristicValue) => {
          this.state.lightOn = value as boolean;
          await device.set({ dps: 15, set: this.state.lightOn, shouldWaitForResponse: false });
          await device.refresh({});
        })
        .onGet(() => this.state.lightOn);

      // Fan Light Brightness
      this.lightService.getCharacteristic(this.platform.Characteristic.Brightness)
        .onSet(async (value: CharacteristicValue) => {
          this.state.lightBrightness = value as number;
          await device.set({ dps: 16, set: this.state.lightBrightness, shouldWaitForResponse: false });

          if (this.state.lightBrightness === 0 && this.state.lightOn) {
            await device.set({ dps: 15, set: false, shouldWaitForResponse: false });
          } else if (this.state.lightBrightness > 0 && !this.state.lightOn) {
            await device.set({ dps: 15, set: true, shouldWaitForResponse: false });
          }
        })
        .onGet(() => this.state.lightBrightness);
    }

    // Update hooks
    const updateHook = (data: TuyaDeviceData) => {
      const isActive = data.dps['1'] as boolean | undefined;
      if (isActive !== undefined) {
        this.state.fanStatus = isActive ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
        this.platform.log.info('Update: Fan status ', isActive ? 'on' : 'off');
        this.fanService.updateCharacteristic(this.platform.Characteristic.Active, this.state.fanStatus);
      }

      const rotation = data.dps['8'] as string | undefined;
      if (rotation !== undefined) {
        this.state.rotationDirection = rotation === 'forward'
          ? this.platform.Characteristic.RotationDirection.CLOCKWISE
          : this.platform.Characteristic.RotationDirection.COUNTER_CLOCKWISE;
        this.platform.log.info('Update: Fan rotation ',
          this.state.rotationDirection === this.platform.Characteristic.RotationDirection.CLOCKWISE ? 'clockwise' : 'counter-clockwise');
        this.fanService.updateCharacteristic(this.platform.Characteristic.RotationDirection, this.state.rotationDirection);
      }

      const speed = data.dps['3'] as number | undefined;
      if (speed !== undefined) {
        const percent = speed * 20; // Map 0-5 to 0-100
        this.state.rotationSpeedStep = speed;
        this.platform.log.info('Update: Fan speed (', percent, '% | speed: ', speed, ')');
        this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, percent);
      }

      const mode = data.dps['2'] as string | undefined;
      if (mode !== undefined) {
        switch (mode) {
          case 'nature':
            this.state.swingMode = this.platform.Characteristic.SwingMode.SWING_ENABLED;
            break;
          case 'smart':
            this.state.swingMode = this.platform.Characteristic.SwingMode.SWING_DISABLED;
            break;
          case 'sleep':
            // HomeKit doesn't have a third mode, so we'll use SWING_DISABLED for sleep as well
            this.state.swingMode = this.platform.Characteristic.SwingMode.SWING_DISABLED;
            break;
        }
        this.platform.log.info('Update: Fan mode ', mode);
        this.fanService.updateCharacteristic(this.platform.Characteristic.SwingMode, this.state.swingMode);
      }

      if (this.lightService) {
        const isLightOn = data.dps['15'] as boolean | undefined;
        if (isLightOn !== undefined) {
          this.state.lightOn = isLightOn;
          this.platform.log.info('Update: Light ', this.state.lightOn ? 'on' : 'off');
          this.lightService.updateCharacteristic(this.platform.Characteristic.On, this.state.lightOn);
        }

        const brightness = data.dps['16'] as number | undefined;
        if (brightness !== undefined) {
          this.state.lightBrightness = brightness;
          this.platform.log.info('Update: Brightness ', this.state.lightBrightness, '%');
          this.lightService.updateCharacteristic(this.platform.Characteristic.Brightness, this.state.lightBrightness);
        }
      }
    };

    device.on('dp-refresh', data => updateHook(data as TuyaDeviceData));
    device.on('data', data => updateHook(data as TuyaDeviceData));

    this.connect(device);
  }

  async connect(device: TuyAPI) {
    try {
      this.platform.log.info('Connecting...');
      await device.find();
      await device.connect();
      this.platform.log.info('Connected');
      
      // Fetch initial state after successful connection
      await this.fetchInitialState(device);
    } catch (e) {
      this.platform.log.info('Connection failed', e);
      this.platform.log.info('Retry in 1 minute');
      setTimeout(() => this.connect(device), 60000);
    }
  }

  async fetchInitialState(device: TuyAPI) {
    try {
      const data = await device.get({ schema: true }) as TuyaDeviceData;
      this.platform.log.info('Initial state:', data);
      
      // Update the state based on the fetched data
      if (data && data.dps) {
        const isActive = data.dps['1'] as boolean | undefined;
        const speed = data.dps['3'] as number | undefined;

        if (isActive !== undefined) {
          this.state.fanStatus = isActive ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
          this.fanService.updateCharacteristic(this.platform.Characteristic.Active, this.state.fanStatus);
        }

        if (speed !== undefined) {
          this.state.rotationSpeedStep = isActive ? speed : 0;
          this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.state.rotationSpeedStep * 20);
        }

        this.platform.log.info('Initial fan status:', isActive ? 'on' : 'off');
        this.platform.log.info('Initial fan speed:', this.state.rotationSpeedStep);
      }
    } catch (error) {
      this.platform.log.error('Error fetching initial state:', error);
    }
  }
}