![Skyfan DC](readme/ceiling-fan.jpg)

# Ventair Skyfan DC

Control Ventair Skyfan DC ceiling fans from HomeKit, over your local network.

- On/off, speed (5 steps) and rotation direction
- Optional Sleep switch
- Light on/off and brightness ([untested](#light-support))

> Unofficial plugin — not affiliated with or endorsed by Ventair. Built against the
> device's local Tuya protocol.

## Requirements

| | |
|---|---|
| Homebridge | 1.8.0 or later (2.x recommended) |
| Node.js | `^22.12.0 \|\| ^24.0.0` |

## Installation

In the Homebridge UI, search Plugins for `homebridge-ventair-ceiling-fan`, install it, then
open the plugin settings.

## Configuration

Every configured fan is listed in the plugin settings — there is no need to edit
`config.json`. From there you can scan the network for fans, paste a local key directly, or
fetch keys from Tuya Cloud with your Access ID and Secret. Cloud credentials are used for
that one request and are **never written to your config**.

Leave **IP** blank unless you need to pin it: fans are discovered automatically, so one that
moves to a new DHCP address keeps working.

To find a device ID and local key by hand, see
[tinytuya's setup wizard](https://github.com/jasonacox/tinytuya/tree/master#setup-wizard---getting-local-keys).

> **One connection per fan.** These devices accept a single local connection at a time. If
> Home Assistant, `tuya-local` or another plugin is connected to a fan, this plugin cannot
> also control it — and vice versa.

## Light support

`hasLight` is implemented but **untested**: no unit available during development had a
light, so the brightness scale is unverified (some Tuya dimmers report 0–100, others
0–1000). If you have a light-equipped Skyfan, please
[open an issue](https://github.com/ruaan-deysel/homebridge-ventair-ceiling-fan/issues).

## Upgrading from 1.x

**Breaking:** the fan mode is no longer exposed through `SwingMode`. Only `Normal` and
`Sleep` are reachable over the local protocol, and `SwingMode` means oscillation — so it was
both wrong and lossy. Mode is now an optional Sleep switch (`exposeModeSwitches`), so
**automations built on the swing control need rebuilding**.

Node 18 and 20 are no longer supported, and `hasLight` now defaults to `false`.

See [CHANGELOG.md](CHANGELOG.md) for the full list.

## Contributing

```bash
npm run lint    # eslint + typecheck
npm test        # vitest
npm run build
```

To release: bump `version` in `package.json`, add a matching `## [x.y.z]` section to
`CHANGELOG.md`, and push to `main`.

## Thanks

[tuyapi](https://github.com/codetheweb/tuyapi) · [@marsuboss](https://github.com/marsuboss)
