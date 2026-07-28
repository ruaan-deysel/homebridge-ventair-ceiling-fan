# Homebridge Ventair Ceiling Fan — Homebridge v2 Modernisation

**Date:** 2026-07-28
**Status:** Approved
**Version target:** 1.0.4 → 2.0.0 (breaking)

## Problem

The plugin cannot run on the target environment. Homebridge v2.0 shipped 2026-05-04 and is
ESM-only; this plugin is CommonJS and imports `Categories` as a *value* from `homebridge`
(`src/platform.ts:1`), which compiles to `require('homebridge')`. On the deployment target that
fails at load.

Beyond the load failure, the codebase has accumulated defects that the rework addresses:

- The DPS mapping is duplicated between the `onSet` handlers and `updateHook`, so speed
  conversion logic exists in three places that must be edited together.
- `config.devices` is assigned with no validation; `ip` and `version` are read off
  `accessory.context.device` untyped and are absent from the `DeviceConfig` interface.
- `error` and `disconnected` both call `connect()` with no in-flight guard and no backoff,
  allowing overlapping retry loops.
- Accessories removed from config are never unregistered — the platform has no stale-accessory
  cleanup.
- `SwingMode` is used to carry the Tuya fan mode (`nature`/`smart`/`sleep`). `SwingMode` means
  oscillation, and `sleep` collapses onto `SWING_DISABLED`, making the round-trip lossy.
- The fan and light services are both assigned the device name, producing HomeKit name warnings.
- `onGet` always returns cached state, so an offline fan still reports its last-known status.
- Every DPS update logs at `info`.
- There are no tests, and the working directory is not a git repository.

## Verified environment

Established live during design, not assumed:

| Fact | Value |
|---|---|
| Homebridge host | `192.0.2.10` (Unraid, hostname `bridge-host`) |
| Homebridge version | 2.2.1 |
| Node version | v24.18.0 |
| Container networking | `host` — Tuya UDP discovery and TCP 6668 work directly on `192.0.2.0/24` |
| Plugins installed | `homebridge-config-ui-x` 5.27.0 only |
| Tuya devices found | 8, all product key `vzj97d3m05yjhchn`, all protocol 3.3 |

Discovered device IDs and addresses:

```
192.0.2.11   bf01000000000000000a    192.0.2.15  bf05000000000000000a
192.0.2.12   bf02000000000000000a    192.0.2.16  bf06000000000000000a
192.0.2.13   bf03000000000000000a    192.0.2.17  bf07000000000000000a
192.0.2.14   bf04000000000000000a    192.0.2.18  bf08000000000000000a
```

Local keys are not present in UDP broadcasts and will be fetched from the user's Tuya IoT
cloud project.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Scope | Modernise **and** fix HomeKit modelling | Modelling is wrong today; fixing it is breaking, hence 2.0.0 |
| Tuya transport | Keep `tuyapi` 7.7.1 behind an internal interface | Proven on protocol 3.3; author has stopped active development, so isolate it for cheap replacement |
| Discovery | Runtime auto-discovery **and** a custom settings UI | 8 devices × 4 hand-typed fields is the real usability problem |
| Live verification | Against real fans, keys via user's Tuya IoT account | — |

## Architecture

```
src/
  index.ts          register the platform
  settings.ts       PLATFORM_NAME / PLUGIN_NAME
  config.ts         Zod schemas → validated, typed config
  dps.ts            pure DPS ↔ FanState mapping + speed conversion
  platform.ts       lifecycle: validate, discover, register, unregister stale
  accessory.ts      HomeKit services ↔ FanState
  tuya/
    device.ts       TuyaDevice interface + FakeTuyaDevice (tests)
    tuyapi.ts       tuyapi-backed impl, owns reconnect + backoff
    discovery.ts    UDP 6666/6667 listener → { id, ip, version }
    cloud.ts        Tuya IoT API client — local-key fetch, UI-server only
homebridge-ui/
  public/index.html scan + cloud-credentials page
  server.js         HomebridgePluginUiServer, reuses dist/tuya/*
test/               Vitest suites
```

### `dps.ts` — the keystone

Pure functions `toFanState(dps)` and `toDps(change)`, with the DPS table defined exactly once.
All speed conversion, mode mapping, and brightness scaling live here. No I/O, fully unit
testable. This eliminates the three-places-must-agree hazard.

DPS table (protocol 3.3, product key `vzj97d3m05yjhchn`):

| DPS | Meaning | Values |
|-----|---------|--------|
| 1 | fan power | boolean |
| 2 | fan mode | enum — **actual values to be confirmed against device** |
| 3 | fan speed | 1–5 |
| 8 | rotation direction | `forward` \| `reverse` |
| 15 | light power | boolean |
| 16 | light brightness | **scale to be confirmed against device** |

### `tuya/device.ts` — the transport seam

```ts
interface TuyaDevice {
  connect(): Promise<void>
  disconnect(): void
  set(dps: Record<string, DpValue>): Promise<void>
  get(): Promise<Record<string, DpValue>>
  readonly connected: boolean
  on(e: 'dps', fn: (d: Record<string, DpValue>) => void): void
  on(e: 'connected' | 'disconnected', fn: () => void): void
}
```

`accessory.ts` depends only on this interface and never imports `tuyapi`. `FakeTuyaDevice`
implements it for offline tests.

### Reconnect supervision

Lives in `tuya/tuyapi.ts`. One in-flight connect attempt at a time; exponential backoff with
jitter from 1s to a 60s cap; retries stop on explicit `disconnect()` during shutdown. This
matters at 8 devices, where the current unguarded double-handler can storm.

### Discovery

`tuya/discovery.ts` listens on UDP 6666/6667 and decodes broadcasts to `{ id, ip, version }`.
Imported by both `platform.ts` (runtime IP/version resolution) and `homebridge-ui/server.js`
(the Scan button) — one implementation, two consumers.

## HomeKit modelling

- **`SwingMode` is removed.** Auto-vs-manual maps to Fanv2's `TargetFanState`
  (`AUTO`/`MANUAL`). Any remaining device modes with no HomeKit equivalent are exposed as
  individual `Switch` services behind the config flag `exposeModeSwitches`, default `false`.
- **Mode and brightness mappings are provisional.** The existing `nature`/`smart`/`sleep`
  values and the 0–100 brightness assumption are both unverified; Tuya dimmers commonly use
  10–1000. **Resolution step:** once a local key is available, connect to one fan and call
  `get({ schema: true })` to dump DPS 2's real enum and DPS 16's declared range, then fix both
  mappings in `dps.ts` before any accessory work is considered complete. This is a blocking
  prerequisite for the `dps.ts` task, not a follow-up.
- **Service names:** fan service keeps the device name, light service becomes `"<name> Light"`.
  Both gain `ConfiguredName`.
- **Offline honesty:** when the transport is disconnected, `onGet` throws
  `SERVICE_COMMUNICATION_FAILURE` so Home shows "No Response" instead of stale state.
- **AccessoryInformation:** real `Model` derived from product key, plus `FirmwareRevision`.
- **Logging:** per-DPS updates drop to `debug`; connection transitions stay `info`. The local
  key is never logged.

## Config validation

```ts
const DeviceSchema = z.object({
  id:       z.string().regex(/^[0-9a-f]{16,26}$/i, 'Tuya device ID looks wrong'),
  key:      z.string().length(16, 'Tuya local keys are exactly 16 characters'),
  name:     z.string().min(1),
  hasLight: z.boolean().default(true),
  ip:       z.ipv4().optional(),          // auto-discovered when absent
  version:  z.enum(['3.1','3.2','3.3','3.4','3.5']).default('3.3'),
})
```

Zod 4 API confirmed: top-level `z.ipv4()` (`.ip()` is v3-compat only) and `z.prettifyError()`
for readable messages.

**Failure policy:** an invalid device entry is logged via `z.prettifyError()` and skipped. It
never takes down the platform. One mistyped key out of eight costs one fan, not the bridge.

`config.schema.json` is updated to match: `key` rendered as a password field, `ip`/`version`
demoted to a collapsed Advanced section, `customUi: true`.

## Custom settings UI

`homebridge-ui/` via `HomebridgePluginUiServer`, two actions:

- **Scan for fans** — reuses `dist/tuya/discovery.js`, lists discovered devices, tick to add.
- **Fetch keys from Tuya Cloud** — Access ID / Secret / region form, signs the IoT API request,
  returns local keys and fills the config.

**Tuya cloud credentials are used transiently for the fetch and are never written to
`config.json`.** A Tuya access secret controls the entire Tuya account and must not persist in
a file that routinely gets pasted into GitHub issues. Local keys are persisted; credentials
are not.

## Packaging and tooling

- `"type": "module"`; tsconfig `module`/`moduleResolution: nodenext`; `.js` extensions on
  relative imports.
- Engines: `node ^22.10.0 || ^24.0.0`, `homebridge ^1.8.0 || ^2.0.0`. Keyword `supports-hap`.
- Dependencies: `tuyapi ^7.7.1`, `zod ^4.4.3`, `homebridge-plugin-ui-utils`.
- `git init` and commit the current state **before** any modification, so the rework is
  reviewable as a diff.
- `dist/` moves to `.gitignore` and is built by CI rather than committed.
- GitHub Actions: lint + test + build on Node 22 and 24.
- `.env` holds the bridge and host credentials used for deployment and is `.gitignore`d. It
  must never be committed, and no credential — bridge password, host password, Tuya local key,
  or Tuya cloud secret — may appear in source, tests, CI config, or log output.

## Testing

Vitest. Most coverage requires no device:

| Suite | Covers |
|---|---|
| `dps.test.ts` | Full DPS round-trip, all 6 speed steps, brightness scaling, mode mapping |
| `config.test.ts` | Valid config parses; bad key length / malformed id / bad version give readable errors; one bad device is skipped while the rest load |
| `accessory.test.ts` | Against `FakeTuyaDevice`: speed 0 turns off, turning on restores step 1, disconnected `onGet` throws |
| `tuyapi.test.ts` | Fake timers: one in-flight connect, backoff grows, `disconnect()` stops retries |

Out of scope: tuyapi's protocol internals, HAP internals.

## Deployment and verification

```
lint + test + build  →  npm pack  →  scp to bridge-host  →  docker cp into homebridge
  →  npm install -C /var/lib/homebridge <tarball>
  →  PUT config via /api/config-editor/plugin/…   →  POST /api/server/restart
  →  read logs, assert clean ESM load + no characteristic warnings
```

All steps were exercised successfully during design (UI auth, plugin listing, SSH to host,
`docker exec` into the container).

**Rollout is staged: one fan proven first, then all eight.** These are live ceiling fans in an
occupied house, and an 8-device reconnect storm is precisely the failure this rework exists to
prevent.

### Acceptance criteria

- Loads clean on Homebridge 2.2.1 / Node 24 with no characteristic warnings.
- All 8 fans appear in HomeKit and respond to on/off, all 5 speeds, direction, light on/off,
  and brightness.
- Discovery resolves a device's IP with no `ip` present in config.
- A deliberately corrupted device entry is logged with a readable message and skipped; the
  remaining devices load and work.
- Unplugging a fan surfaces "No Response" in Home; replugging recovers without a retry storm.

## Risks

- **One TCP connection per Tuya device.** tuyapi holds a single socket per device. If Home
  Assistant, another Homebridge plugin, or another integration already talks to these fans
  locally, the two will contend for the socket. Confirm what currently controls them before
  pointing 8 connections at them.
- **Breaking change for existing users.** Removing `SwingMode` breaks any automation built on
  it. Must be called out explicitly in the 2.0.0 release notes.
- **Provisional mappings.** Mode and brightness semantics are unconfirmed until a live device
  is read; if DPS 16 turns out to be 1000-scale, every brightness value the plugin has ever
  set has been wrong.
- **`tuyapi` is stagnant.** Mitigated, not eliminated, by the `TuyaDevice` seam.
