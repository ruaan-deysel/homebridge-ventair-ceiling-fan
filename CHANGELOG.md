# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Consolidated the DPS mapping and speed conversion into a single pure module. It previously
  existed in three places that had to be kept in sync by hand.
- Corrected the datapoint map against live hardware: countdown is datapoint 22, not 2. The
  fan mode datapoint reports `Normal`, a value absent from Tuya's published specification,
  and only `Normal` and `Sleep` are reachable over the local protocol.
- A missing speed datapoint is now treated as unknown rather than zero. Some fans omit it
  entirely, and the old behaviour reported a running fan as stopped.
- **BREAKING:** Migrated to ESM. Homebridge v2 is ESM-only, and the previous CommonJS
  build could not load on it at all.
- **BREAKING:** Node.js 18 and 20 are no longer supported. Requires Node 22.10+ or 24.
- Minimum Homebridge version raised to 1.8.0; Homebridge 2.x supported.
- `Categories` is now read from `api.hap` rather than imported as a value from `homebridge`,
  avoiding the CommonJS/ESM dual-package hazard.
- Replaced the deprecated `Logger` type with `Logging`.

- **BREAKING:** `hasLight` is no longer required and now defaults to `false`. No Skyfan DC
  unit tested during this work had a light.
- `ip` is now optional — leave it blank to have the fan discovered automatically.

### Added

- Config is now validated with Zod. Invalid device entries are reported with an actionable
  message and skipped, so one mistyped key no longer prevents the whole platform loading.
- New `exposeModeSwitches` option (default `false`).
- Vitest test suite and GitHub Actions CI across Node 22 and 24.

### Removed

- `dist/` is no longer committed to the repository; it is built on demand.
