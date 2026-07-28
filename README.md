
![ceiling-fan.jpg](readme/ceiling-fan.jpg)

# Ventair Skyfan DC Ceiling Fan

Control your Skyfan DC Ceiling Fan from HomeKit.
- Turn on/off
- Set speed
- Set rotation direction
- Set light on/off
- Set light brightness

## Installation

Go to the Homebridge UI, Plugins screen and search for `homebridge-ventair-ceiling-fan`. Install the plugin and use the form to configure it.


## Configuration

To get your `Id` and `Key` ceiling fan, follow the instructions [Getting your keys](https://github.com/jasonacox/tinytuya/tree/master#setup-wizard---getting-local-keys)

## Matter (beta, opt-in)

Each fan can also be exposed as a Matter device, so non-Apple ecosystems can control it
alongside HomeKit. This requires Matter to already be enabled on your Homebridge bridge
(`bridge.matter` in your Homebridge config) — Matter support in Homebridge is itself beta.

Enable it per-fan with the "Expose to Matter" option in the plugin settings
(`exposeMatter`, off by default). If your bridge doesn't have Matter enabled, this option
has no effect and a warning is logged.

**Known limitation:** Matter's `FanControl` cluster has no rotation-direction attribute, so
reverse/forward rotation is only available through HomeKit, not through Matter.

## Thanks

- [tuyapi](https://github.com/codetheweb/tuyapi)
- @marsuboss
# homebridge-ventair-ceiling-fan
