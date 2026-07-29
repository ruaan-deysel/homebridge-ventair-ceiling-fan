<p align="center">
  <img src="branding/icon.png" alt="" width="120">
</p>

# Ventair Skyfan DC

Control Ventair Skyfan DC ceiling fans from HomeKit, over your local network.

- Turn on/off
- Set speed (5 steps)
- Set rotation direction
- Sleep mode switch (optional)
- Light on/off and brightness (see [Light support](#light-support))

> **Unofficial plugin.** Not affiliated with, endorsed by, or supported by Ventair.
> "Ventair" and "Skyfan" are trademarks of their respective owner. This project is an
> independent integration built against the device's local Tuya protocol.

## Requirements

| | |
|---|---|
| Homebridge | 1.8.0 or later (2.x recommended) |
| Node.js | `^22.12.0 \|\| ^24.0.0` |

Version 2.0.0 of this plugin is ESM-only. This is a choice specific to this package,
not a requirement Homebridge itself imposes — plenty of Homebridge plugins are still
CommonJS.

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

## Light support

The plugin supports fans with an integrated light (`hasLight`), but **this path is
untested**. No unit available during development had a light, so the brightness scale in
particular is unverified — some Tuya dimmers report 0–100 and others 0–1000. If you have a
light-equipped Skyfan, please
[open an issue](https://github.com/ruaan-deysel/homebridge-ventair-ceiling-fan/issues) with
what you observe.

## Upgrading from 1.x

**Breaking:** the fan mode is no longer exposed through `SwingMode`. On this hardware only
two modes are actually reachable over the local protocol (`Normal` and `Sleep`), and
`SwingMode` means oscillation, not mode — so it was both wrong and lossy. Mode is now an
optional **Sleep** switch (`exposeModeSwitches`).

**Any automation built on the fan's swing control will need rebuilding.**

Also breaking: Node 18/20 are no longer supported, and `hasLight` now defaults to `false`.

See [CHANGELOG.md](CHANGELOG.md) for the full list.

## Releasing

The version in `package.json` is the single input. Bump it on `main`, add a matching
`## [x.y.z]` section to `CHANGELOG.md`, and push:

```bash
npm version patch   # or minor / major — writes package.json and commits
git push origin main
```

`.github/workflows/publish.yml` then runs the full gate, tags `vx.y.z`, creates the
GitHub release from that CHANGELOG section, and publishes to npm via Trusted Publishing
(OIDC — there is no npm token in this repo). Re-running it, or pushing an unrelated
`package.json` change, is a no-op: it skips when the tag already exists or the version is
already on npm.

A missing CHANGELOG section fails the run *before* anything is tagged or published.

## Homebridge verified-plugin compliance

How this plugin currently maps to Homebridge's verified-plugin requirements:

| Requirement | Status |
| --- | --- |
| Dynamic platform | Yes — implements `DynamicPlatformPlugin`. |
| Does not duplicate an existing verified plugin | Judgement call for the Homebridge team, not something this repo can self-certify. Verified Tuya platform plugins already exist, but this one is device-specific to the Ventair Skyfan DC rather than a general Tuya integration. |
| Published to npm, with GitHub source and issues enabled | Yes — published as [`homebridge-ventair-ceiling-fan`](https://www.npmjs.com/package/homebridge-ventair-ceiling-fan), source on GitHub with issues enabled. |
| A GitHub release per version, with notes | `.github/workflows/release.yml` creates a GitHub release from the matching `CHANGELOG.md` section whenever a `v*` tag is pushed. |
| Runs on all supported LTS Node versions | CI (`.github/workflows/ci.yml`) runs the test suite on Node 22.x and 24.x. |
| Installs successfully, doesn't start unless configured | Yes — the platform returns cleanly (with a warning) when no devices are configured. |
| No post-install scripts modifying the system | Yes — no `postinstall`/`preinstall` scripts. |
| No TTY requirement | Yes — no interactive prompts. |
| Implements the Settings GUI | Yes — `homebridge-ui` provides network scan and Tuya IoT key lookup. |
| No analytics or user tracking | Yes — the only network calls are to the configured Tuya devices and the Tuya IoT API used for key lookup. |
| Files written go in the Homebridge storage directory | Yes — the plugin performs no disk writes of its own. |
| Must not throw unhandled exceptions; catches and logs its own errors | Every device write is wrapped in try/catch or `.catch()` that logs at `warn` with the device name, so one fan's write failure cannot crash the bridge. |

### Known upstream warning

`npm install` prints a deprecation warning for `q@1.1.2`. It comes from
`homebridge` → `@homebridge/hap-nodejs` → `node-persist`, three levels upstream of this
plugin. It is not fixable here without `overrides`/`resolutions`/patching, which risks
breaking `hap-nodejs`, so it is left alone and documented instead.

## Plugin icon

Homebridge resolves plugin icons from its central
[plugins registry](https://github.com/homebridge/plugins), keyed by npm package name —
there is no `package.json` field for it, and shipping an image in the package has no effect.

`branding/icon.png` is an original generic fan mark (deliberately not Ventair branding,
since this is an unofficial plugin). The package is already published under its final name,
so the icon request can be raised at
[homebridge/plugins](https://github.com/homebridge/plugins/issues/new/choose).

## Thanks

- [tuyapi](https://github.com/codetheweb/tuyapi)
- @marsuboss
