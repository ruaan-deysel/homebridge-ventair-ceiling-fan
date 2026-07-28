<p align="center">
  <img src="branding/icon.png" alt="" width="120">
</p>

# Homebridge Ventair Skyfan DC Ceiling Fan

Control Ventair Skyfan DC ceiling fans from HomeKit, over your local network.

- Turn on/off
- Set speed (5 steps)
- Set rotation direction
- Sleep mode switch (optional)
- Light on/off and brightness (see [Light support](#light-support))
- Optional Matter exposure (see [Matter](#matter-beta-opt-in))

> **Unofficial plugin.** Not affiliated with, endorsed by, or supported by Ventair.
> "Ventair" and "Skyfan" are trademarks of their respective owner. This project is an
> independent integration built against the device's local Tuya protocol.

## Requirements

| | |
|---|---|
| Homebridge | 1.8.0 or later (2.x recommended) |
| Node.js | 22.10+ or 24 |

Version 2.0.0 is ESM-only, which Homebridge v2 requires.

## Installation

In the Homebridge UI go to **Plugins**, search for `homebridge-ventair-ceiling-fan`, and
install. Then open the plugin settings to configure your fans.

## Configuration

Open the plugin settings in the Homebridge UI. Every fan already in your config is listed
there first — name, device ID, whether a local key is set, and its toggles — with no need
to open `config.json`. From there you can:

- **Scan** the network to find fans and badge each configured fan as found or not found
  (a fan is never removed automatically just because a scan missed it).
- **Paste a local key directly** into any fan — this always works and needs no cloud
  credentials.
- **Fetch keys from Tuya Cloud** using your Access ID/Secret, for one fan or all of them
  at once. Tuya time-limits how long an IoT-portal project can pull device data, so cloud
  fetch can eventually stop working for older projects — manual key entry is the
  supported fallback, not an afterthought.

Cloud credentials are used for the request only and are **never written to your config**.

To get your device ID and local key manually, follow
[Getting your keys](https://github.com/jasonacox/tinytuya/tree/master#setup-wizard---getting-local-keys).

Leave **IP** blank unless you need to pin it — the plugin discovers each fan on the
network at startup, so a fan that moves to a new DHCP address keeps working.

### One connection per fan

These devices accept only **one local connection at a time**. If another integration
(Home Assistant, `tuya-local`, another Homebridge plugin) is already connected to a fan,
this plugin cannot also control it, and vice versa.

## Matter (beta, opt-in)

Each fan can also be exposed as a Matter device, so non-Apple ecosystems can control it
alongside HomeKit. This requires Matter to already be enabled on your Homebridge bridge
(`bridge.matter` in your Homebridge config) — Matter support in Homebridge is itself beta.

Enable it per-fan with the "Expose to Matter" option in the plugin settings
(`exposeMatter`, off by default). If your bridge doesn't have Matter enabled, this option
has no effect.

**Known limitation:** Matter's `FanControl` cluster has no rotation-direction attribute, so
reverse/forward rotation is only available through HomeKit, not through Matter.

## Light support

The plugin supports fans with an integrated light (`hasLight`), but **this path is
untested**. No unit available during development had a light, so the brightness scale in
particular is unverified — some Tuya dimmers report 0–100 and others 0–1000. If you have a
light-equipped Skyfan, please
[open an issue](https://github.com/domalab/homebridge-ventair-ceiling-fan/issues) with
what you observe.

## Upgrading from 1.x

**Breaking:** the fan mode is no longer exposed through `SwingMode`. On this hardware only
two modes are actually reachable over the local protocol (`Normal` and `Sleep`), and
`SwingMode` means oscillation, not mode — so it was both wrong and lossy. Mode is now an
optional **Sleep** switch (`exposeModeSwitches`).

**Any automation built on the fan's swing control will need rebuilding.**

Also breaking: Node 18/20 are no longer supported, and `hasLight` now defaults to `false`.

See [CHANGELOG.md](CHANGELOG.md) for the full list.

## Plugin icon

Homebridge resolves plugin icons from its central
[plugins registry](https://github.com/homebridge/plugins), keyed by npm package name —
there is no `package.json` field for it. `branding/icon.png` is prepared for that request,
which can be raised at
[homebridge/plugins](https://github.com/homebridge/plugins/issues/new/choose) once this
package is published under its final name.

## Thanks

- [tuyapi](https://github.com/codetheweb/tuyapi)
- @marsuboss
