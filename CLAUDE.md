# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build      # rimraf dist && tsc
npm run lint       # eslint . --max-warnings=0, then npm run typecheck
npm run typecheck  # tsc -p tsconfig.test.json (no emit; covers src, test and vitest.config.ts)
npm test           # vitest run
npm run watch      # build + npm link + nodemon (runs `homebridge -I -D` on src change)
```

`prepublishOnly` runs lint + test + build. The test suite does **not** need a prior build:
`vitest.config.ts` aliases `../dist/*.js` to `src/*.ts` for `homebridge-ui/server.js`, whose
runtime imports must keep pointing at `dist/` because that is all the published package ships.

## Architecture

Homebridge *dynamic platform* plugin bridging Tuya-protocol Ventair Skyfan DC ceiling fans
into HomeKit.

- `src/index.ts` — registers the platform with Homebridge.
- `src/settings.ts` — `PLATFORM_NAME` (must match `pluginAlias` in `config.schema.json`) and `PLUGIN_NAME` (must match `name` in `package.json`).
- `src/config.ts` — Zod schema for the platform config. A bad device entry costs that one fan, never the bridge, and **never** unregisters an accessory (that would irreversibly discard its rooms, scenes and automations).
- `src/platform.ts` — reads `config.devices[]`, generates a HAP UUID from the Tuya device id, and constructs one `CeilingFanAccessory` per device (restoring cached accessories where present).
- `src/dps.ts` — the datapoint ↔ `FanState` translation, both directions. The only place DP numbers appear.
- `src/accessory.ts` — HomeKit services and characteristic handlers, optimistic state with per-key versioning, and rollback that restores only device-confirmed values.
- `src/tuya/tuyapi.ts` — the transport: one `TuyAPI` connection per accessory, the reconnect supervisor, and the write/readback path. **Do not touch `verifyWrite`, `awaitEcho`, `writeOnce`, the echo-suppression window or the reconnect supervisor** without live-hardware verification; that code was tuned against real fans.
- `src/tuya/discovery.ts` — UDP broadcast discovery (ports 6666/6667, published AES-ECB key).
- `src/tuya/cloud.ts` — Tuya Cloud API client used only to fetch local keys, including the IPv4-preferring agent + alternate-family retry for tuya/tuya-homebridge#412.
- `homebridge-ui/` — the custom Homebridge UI: `server.js` (plain ESM JS, `/discover` and `/keys`) and `public/index.html` (one self-contained page, no build step).

### Tuya DPS mapping

| DP | Meaning | Values |
|----|---------|--------|
| 1 | fan power | boolean |
| 2 | fan mode | `'Normal'` \| `'Sleep'` (capitalised on the wire) |
| 3 | fan speed | 1–5 |
| 8 | rotation direction | `'forward'` \| `'reverse'` |
| 15 | light power | boolean (untested — no unit here has a light) |
| 16 | light brightness | device scale, mapped to 0–100 |
| 22 | countdown | present on the hardware, deliberately unimplemented |

Confirmed by write probe on live hardware: the fan accepts **only** Normal and Sleep over
the LAN. The cloud spec's `nature`/`smart` are resolved by index and come back as Sleep, so
unrecognised mode strings are preserved rather than mapped. `exposeModeSwitches` therefore
adds a single Sleep switch — there is no third mode and no `SwingMode` mapping any more.

Speed is exposed as 0–100% with `minStep: 20`; conversion lives in `stepToPercent` /
`percentToStep` in `src/dps.ts` and nowhere else.

### Connection lifecycle

`TuyapiDevice.connect()` is supervised: exponential backoff with jitter, capped at 60s,
with a single in-flight attempt (`inFlight`) so `error` and `disconnected` arriving together
cannot start two loops. A readback timeout recreates the whole underlying `TuyAPI` instance
— tuyapi 7.7.1 keeps a per-sequence resolver it never clears, and there is no cancellation
API — and the discarded instance is both `disconnect()`ed and `removeAllListeners()`ed.

`set()` runs with `shouldWaitForResponse: false`, so it can never reject; a write is
confirmed by the fan echoing the value back, or by a bounded readback poll. Echoes for a
datapoint with a write in flight are buffered, not dropped, and reconciled against an
authoritative read once the settle window closes — that is how a wall switch or the Smart
Life app still reaches HomeKit.

## Config

`config.schema.json` drives the standard Homebridge form; `homebridge-ui/public/index.html`
drives the custom one. Adding a per-device option means touching the schema, the Zod schema
in `src/config.ts`, the custom UI, and the accessory — and keeping the wording consistent
across all of them.

## Conventions

- No credentials, local keys, real IPs, real device IDs or passwords in any file, test,
  comment or commit message. Fixtures use `192.0.2.x` and synthetic IDs like `bf0…000a`.
- Commit messages carry no tool attribution or `Co-Authored-By` trailers.
- New behaviour gets a test that demonstrably fails without the change.
