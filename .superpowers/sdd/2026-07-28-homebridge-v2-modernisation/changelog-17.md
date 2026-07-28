### Added

- `.github/workflows/release.yml`: creates a GitHub release with notes pulled from the
  matching `CHANGELOG.md` section whenever a `v*` tag is pushed. `npm publish` is
  intentionally left commented out — enabling it requires an `NPM_TOKEN` secret.
- Regression test asserting a rejected transport write is caught and logged instead of
  crashing the bridge (`test/accessory.test.ts`).
- README section mapping the plugin to Homebridge's verified-plugin requirements.

### Fixed

- Four floating promises that could produce unhandled rejections and take down the bridge
  on a device write failure: `MatterFanBridge`'s `setPower`/`setPercent` callbacks
  (`src/matter.ts`), `removeStaleMatterAccessories`'s Matter unregister call
  (`src/platform.ts`), and the Sleep switch's write-then-sync chain (`src/accessory.ts`).
  All now log at `warn` with the device name and continue.

### Changed

- CI: `actions/checkout` v4 → v7, `actions/setup-node` v4 → v7, added `cache: 'npm'`.
  Node 22.x/24.x matrix unchanged.
- `@types/node` pinned to `^24` to match `engines.node` (was `^25.6.0`, ahead of the
  supported runtime).

### Documented

- The upstream `q@1.1.2` deprecation warning (via `homebridge` → `@homebridge/hap-nodejs`
  → `node-persist`) is not fixable here without risking `hap-nodejs` breakage; documented
  in the README rather than patched.
