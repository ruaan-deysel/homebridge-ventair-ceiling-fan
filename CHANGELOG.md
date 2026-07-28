# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **BREAKING:** Migrated to ESM. Homebridge v2 is ESM-only, and the previous CommonJS
  build could not load on it at all.
- **BREAKING:** Node.js 18 and 20 are no longer supported. Requires Node 22.10+ or 24.
- Minimum Homebridge version raised to 1.8.0; Homebridge 2.x supported.
- `Categories` is now read from `api.hap` rather than imported as a value from `homebridge`,
  avoiding the CommonJS/ESM dual-package hazard.
- Replaced the deprecated `Logger` type with `Logging`.

### Added

- Vitest test suite and GitHub Actions CI across Node 22 and 24.

### Removed

- `dist/` is no longer committed to the repository; it is built on demand.
