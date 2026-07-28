# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

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
- Opt-in Matter exposure per fan (`exposeMatter`, default `false`). Requires Matter to be
  enabled on the Homebridge bridge. Registers a `Fan` device with `onOff` and `fanControl`
  clusters, wires the on/off, percent-setting and fan-mode handlers, and pushes
  device-initiated changes back to Matter. Cached Matter accessories are tracked across
  restarts and stale ones unregistered, mirroring the HomeKit path.
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
- Matter's `FanControl` cluster has no rotation-direction attribute in the version exposed
  by Homebridge, so reverse rotation stays HomeKit-only.
