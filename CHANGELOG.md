# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.1] - 2026-07-29

### Fixed

- Scanning the network no longer marks working fans as **Not found on network**. A scan
  that finds nothing cannot tell "no fan is online" apart from "the broadcasts never
  reached Homebridge" — with Docker bridging, AP client isolation or a VLAN that drops
  broadcasts, every configured fan was flagged while all of them were reachable and
  controllable. A scan that finds some fans but misses one still warns about that fan.
- The scan result now says explicitly when nothing was found and that fan status was left
  unchanged, so a green badge beside "Found 0" cannot be read as "this fan answered".

### Changed

- Log messages from the Tuya transport identify a fan by its configured name instead of
  its device id. The full id identifies real hardware and appeared in every warning, so
  pasting a log into a bug report published it. An id suffix alone would not have been
  safe either: ids from one production batch differ only in their final characters.
- **Known limitation:** running Homebridge with `DEBUG=TuyAPI` makes the `tuyapi`
  dependency print its own payloads, including the full device id. That output bypasses
  this plugin, so redact debug logs before sharing them.

### Documentation

- Corrected the claim, repeated in `CLAUDE.md`, `src/dps.ts`, `src/accessory.ts` and in
  the 2.0.0 entry below, that the fan has only `Normal` and `Sleep`. A fan driven from the
  Smart Life app reported a third mode, `eco`. The earlier write probe showed only that
  `nature`/`smart` are not writable over the LAN — not that the mode set is closed.
  Whether `Eco` can be written over the LAN is still untested, because a fan accepts one
  LAN session at a time and the plugin holds it. Inbound `eco` is preserved correctly and
  needed no code change; HomeKit cannot currently display or restore it.

## [2.0.0] - 2026-07-29

### Removed

- **BREAKING:** Matter support. It was opt-in and Homebridge's own Matter support is
  still beta; the fans are exposed through HomeKit normally. Removing it also deleted a
  second optimistic-state implementation that had to be kept in lockstep with the
  HomeKit one, which was the source of several state-divergence defects.
- **BREAKING:** `SwingMode` no longer carries the fan mode. Only `Normal` and `Sleep` are
  reachable on the real hardware — writing anything else, including Tuya's published
  `nature`/`smart` values, lands on `Sleep` — and there is no manual mode for
  `TargetFanState` to represent. Neither characteristic is used any more.
  **Any automation built on the fan's swing control will need rebuilding.**
- `dist/` is no longer committed to the repository; it is built on demand.

### Added

- Automatic device discovery over the local network. The plugin resolves each fan's IP
  address and protocol version at runtime, so only id, key and name need configuring.
- Custom settings UI: scan the network for fans, then fetch their local keys from your
  Tuya IoT account, instead of typing every field by hand.
- Config is now validated with Zod. Invalid device entries are reported with an actionable
  message and skipped, so one mistyped key no longer prevents the whole platform loading.
- Optional `Sleep` switch per fan (`exposeModeSwitches`): on writes `Sleep`, off writes
  `Normal`.
- Vitest test suite and GitHub Actions CI across Node 22 and 24.

### Changed

- **BREAKING:** Migrated to ESM. Homebridge v2 is ESM-only, and the previous CommonJS build
  could not load on it at all.
- **BREAKING:** Node.js 18 and 20 are no longer supported. Requires Node 22.10+ or 24.
- **BREAKING:** `hasLight` is no longer required and now defaults to `false`. No Skyfan DC
  unit tested during this work had a light.
- Minimum Homebridge version raised to 1.8.0; Homebridge 2.x supported.
- `ip` is now optional — leave it blank to have the fan discovered automatically.
- Consolidated the datapoint mapping and speed conversion into a single pure module. It
  previously existed in three places that had to be kept in sync by hand.
- Corrected the datapoint map against live hardware: the countdown timer is datapoint 22,
  not 2. The fan mode datapoint reports `Normal`, a value absent from Tuya's published
  specification.
- Device writes go out as a sequence of single-datapoint calls. An earlier draft batched
  them into one multi-datapoint call, but that was reverted after live hardware showed
  this firmware silently ignores batched writes.
- `tuyapi` is now confined behind an internal interface so it can be replaced without
  touching the rest of the plugin.
- `Categories` is read from `api.hap` rather than imported as a value from `homebridge`,
  avoiding the CommonJS/ESM dual-package hazard.
- Replaced the deprecated `Logger` type with `Logging`.

### Fixed

- Writes are confirmed from the fan's own state push rather than a polled readback. Both
  the per-datapoint and full-schema queries keep reporting a datapoint's previous value
  for seconds after a write, so every successful write was reported to HomeKit as a
  communication failure. Verified on eight fans: zero write failures where the previous
  build failed every write.
- A device whose config entry fails validation is no longer unregistered from HomeKit.
  A mistyped key removed the accessory along with its room, scenes and automations.
- Device IDs are no longer required to be hexadecimal. Real Tuya IDs are alphanumeric,
  and affected fans were silently dropped at startup.
- Duplicate device IDs in config are rejected instead of producing duplicate accessories.
- A protocol version discovered over UDP is now used. A 3.4/3.5 fan was constructed as
  3.3 and could never connect.
- A UDP socket error during discovery can no longer crash Homebridge.
- `disconnect()` settles pending writes instead of leaving callers awaiting forever.

- Fixed a reconnect storm. The `error` and `disconnected` handlers both called `connect()`
  with no in-flight guard and no backoff, so a single failure could spawn overlapping retry
  loops. Retries are now serialised with exponential backoff and jitter, capped at 60s.
- Accessories removed from the config are now unregistered. Previously they stayed
  registered forever, leaving dead tiles in the Home app.
- Offline fans no longer report stale state. HomeKit now shows "No Response" when the
  plugin cannot reach a device, instead of continuing to display the last known values.
- A missing speed datapoint is treated as unknown rather than zero. Some fans omit it
  entirely, and the old behaviour reported a running fan as stopped.
- The fan and light services no longer share a name, which caused HomeKit name warnings.
- Per-datapoint updates now log at debug level instead of info.

### Security

- Tuya cloud credentials entered in the settings UI are used for a single request and are
  never written to `config.json`. An access secret controls the entire Tuya account, and
  config files are routinely shared in bug reports.

### Known limitations

- Light support is **untested**. No fan available during this work had a light, so the
  brightness scale in particular is unverified.
