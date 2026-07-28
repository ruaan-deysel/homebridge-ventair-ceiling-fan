# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build    # rimraf dist && tsc
npm run lint     # eslint src/**/*.ts --max-warnings=0
npm run watch    # build + npm link + nodemon (runs `homebridge -I -D` on src change)
```

No test suite exists. `prepublishOnly` runs lint + build.

## Architecture

Homebridge *dynamic platform* plugin bridging a Tuya-protocol Ventair Skyfan DC ceiling fan into HomeKit. Four files, ~380 lines:

- `src/index.ts` — registers the platform with Homebridge.
- `src/settings.ts` — `PLATFORM_NAME` (must match `pluginAlias` in `config.schema.json`) and `PLUGIN_NAME` (must match `name` in `package.json`).
- `src/platform.ts` — reads `config.devices[]`, generates a HAP UUID from the Tuya device id, and constructs one `CeilingFanAccessory` per device (restoring cached accessories where present).
- `src/platformAccessory.ts` — everything else: one `TuyAPI` connection per accessory, HomeKit characteristic handlers, and the inbound state sync.

### Tuya DPS mapping

The device speaks Tuya "data points". This mapping is the core domain knowledge and is duplicated between the `onSet` handlers and the inbound `updateHook`:

| DPS | Meaning | Values |
|-----|---------|--------|
| 1 | fan power | boolean |
| 2 | fan mode | `'nature'` \| `'smart'` \| `'sleep'` |
| 3 | fan speed | 1–5 |
| 8 | rotation direction | `'forward'` \| `'reverse'` |
| 15 | light power | boolean |
| 16 | light brightness | 0–100 |

Speed is exposed to HomeKit as 0–100% with `minStep: 20`, so percent ↔ step conversion (`×20` / `÷20`) appears in three places — change them together.

HomeKit has no third fan mode, so `SwingMode` carries mode: `SWING_ENABLED` → `nature`, `SWING_DISABLED` → `smart`, and inbound `sleep` also collapses to `SWING_DISABLED` (lossy round-trip; a `sleep` device state reads back as `smart`).

### Connection lifecycle

`connect()` does `find()` then `connect()`, then `fetchInitialState()`. On failure it retries every 60s. `disconnected` and `error` events both call `connect()` again — the reconnect loop is the accessory's only resilience mechanism, and there is no backoff or cancellation, so avoid adding paths that can call `connect()` concurrently.

All `device.set()` calls use `shouldWaitForResponse: false` — writes are fire-and-forget and local `this.state` is updated optimistically. Real state arrives asynchronously via the `data` / `dp-refresh` events, both routed through `updateHook`.

## Config

`config.schema.json` drives the Homebridge UI form. Adding a per-device option means touching the schema, the `DeviceConfig` interface in `platform.ts` (which is currently narrower than the schema — `ip` and `version` are read off `accessory.context.device` untyped), and the accessory.
