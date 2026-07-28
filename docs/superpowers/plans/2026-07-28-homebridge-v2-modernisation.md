# Homebridge Ventair Ceiling Fan — v2 Modernisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the plugin from CommonJS to ESM so it loads on Homebridge 2.2.1 / Node 24, add Zod config validation, isolate tuyapi behind a swappable interface, fix the reconnect storm and the incorrect HomeKit modelling, and verify the result on eight real ceiling fans.

**Architecture:** A pure `dps.ts` owns the single DPS mapping table. `tuya/` isolates all tuyapi contact behind a `TuyaDevice` interface with a reconnect supervisor, plus a UDP discovery module shared by the platform and the settings UI. `platform.ts` validates config through Zod and manages accessory lifecycle; `accessory.ts` maps `FanState` onto HomeKit services and never sees tuyapi.

**Tech Stack:** TypeScript 6 (ESM, `nodenext`), Homebridge 1.8/2.x, Zod 4.4.3, tuyapi 7.7.1, Vitest 4, `@homebridge/plugin-ui-utils` 2.2.5, ESLint 9 flat config.

**User decisions (already made):**
- Scope: "Modernise + fix modelling" — breaking changes accepted, ships as 2.0.0.
- Transport: "Keep tuyapi, isolate it" behind an internal interface.
- Discovery: "Runtime discovery + custom settings UI".
- Verification: against real fans; keys fetched from the user's Tuya IoT account.
- Fan mode: "Three switches, off by default" — `TargetFanState` explicitly rejected (no manual mode exists on the hardware).
- Countdown timer: "Leave it out" — out of scope.
- Rollout: staged, one fan proven before all eight.
- Confirmed 2026-07-28: nothing else currently controls these fans locally.

---

## Measured facts (do not re-derive)

Established during design against live hardware and the Tuya cloud API:

| Fact | Value |
|---|---|
| Bridge | `192.0.2.10:8581`, Homebridge 2.2.1, Node v24.18.0 |
| Host | Unraid `bridge-host`, Homebridge container uses **host** networking |
| Fans | 8 × Ventair Skyfan DC, product key `vzj97d3m05yjhchn`, category `fs`, protocol 3.3 |
| DP indices | **1** power (bool), **2** mode (string), **3** speed (1–5, *can be absent*), **8** direction, **22** countdown (unused). Measured over LAN. |
| Mode values | Device reports **`Normal`**; only `Normal` and `Sleep` are reachable while the fan is off. Cloud's `nature/sleep/smart` enum is **incomplete and partly unreachable**. Retest powered-on in #10. |
| Lights | None. DP 15/16 absent on all 8 units. |
| Broken API | `tuyapi.refresh({})` **hangs** — timed out at 20s against a healthy device. Do not use it. |
| Lights | **None.** No light DPs exist on any of the 8 units |
| Keys | All exactly 16 chars, contain `` ` `` `|` `$` `<` `!` `?` `'` — must be quoted carefully |
| Credentials | `.env` (gitignored) — bridge, Unraid host, and Tuya cloud |

Room → IP map is in the spec. **Keys must never be written into the repository.**

## Conventions

**CHANGELOG discipline.** `CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/)
and is updated **in the same commit as the change it describes** — never retrofitted at the end.
Every task below ends with a changelog entry as part of its commit step. Entries accumulate
under `## [Unreleased]` and are promoted to `## [2.0.0]` in task #10.

Categories used: `Added`, `Changed`, `Fixed`, `Removed`, `Security`. Breaking changes are
prefixed `**BREAKING:**`.

**Adversarial review gate.** The work is not done when task #10 passes. Task #12 runs
`/codex:adversarial-review` over the full branch to challenge the design, not just hunt defects.

## Execution order

Task numbers match native task IDs, so they are not sequential in dependency order. Execute in this order:

```
#11 (LAN DP indices)  ──┐
#1  (ESM packaging)   ──┼──> #3 (dps.ts)    ──┐
                        ├──> #4 (config.ts) ──┼──> #7 (platform.ts) ──┐
                        ├──> #5 (tuya seam) ──┤                       ├──> #10 (deploy + verify)
                        └──> #6 (discovery) ──┴──> #8 (accessory.ts) ─┤
                                              └──> #9 (settings UI)  ──┘

#10 ──> #12 (adversarial review — user-invoked)
```

`#2` (device capability investigation) is already complete.

---

### Task #11: Confirm numeric DP indices over the LAN

**Goal:** Replace the inherited 1/2/3/8 numeric DP assumption with a measured mapping, before any code depends on it.

**Files:**
- Create: `scripts/dump-schema.mjs` (throwaway, not shipped — add to `.gitignore`)
- Modify: `docs/superpowers/specs/2026-07-28-homebridge-v2-modernisation-design.md` (DPS table)

**Acceptance Criteria:**
- [ ] A LAN connection is made to one fan using its local key
- [ ] `get({ schema: true })` output captured showing numeric DP keys and values
- [ ] Each numeric DP is matched to its cloud code by correlating values against the known cloud status
- [ ] Spec DPS table updated with confirmed indices, and the "unconfirmed" caveat removed
- [ ] No key appears in any committed file or in captured output

**Verify:** `node scripts/dump-schema.mjs` prints a dps object whose keys are numeric; the power/speed/mode/direction values match the cloud status for the same fan.

**Steps:**

- [ ] **Step 1: Write the dump script**

Read credentials from the environment — never hardcode.

```js
// scripts/dump-schema.mjs
import TuyAPI from 'tuyapi'

const device = new TuyAPI({
  id: process.env.FAN_ID,
  key: process.env.FAN_KEY,
  ip: process.env.FAN_IP,
  version: '3.3',
  issueRefreshOnConnect: true,
})

device.on('error', e => console.error('error:', e.message))

await device.find()
await device.connect()
const schema = await device.get({ schema: true })
console.log(JSON.stringify(schema, null, 2))
device.disconnect()
```

- [ ] **Step 2: Install tuyapi locally so the script can run**

```bash
npm install
```

- [ ] **Step 3: Run against the Family Room fan**

Pass the key via env so it never lands in shell history as a literal in a committed file. Note the key contains shell metacharacters — single-quote it.

```bash
FAN_ID=bf01000000000000000a FAN_IP=192.0.2.11 FAN_KEY='<key>' node scripts/dump-schema.mjs
```

Expected: a `{ dps: { "1": false, "2": "nature", "3": 1, ... } }` object.

If the connection fails, the fan may not accept a second LAN socket, or the IP may have changed — re-run discovery (`scripts/` equivalent of `src/tuya/discovery.ts`) to get the current address.

- [ ] **Step 4: Correlate and record**

Cross-check each numeric key against the cloud status for the same device (`switch=false`, `mode=nature`, `fan_speed_percent=1`, `fan_direction=forward` at time of writing). Write the confirmed mapping into the spec's DPS table and delete the "Still unverified" paragraph.

- [ ] **Step 5: Commit**

```bash
echo "scripts/" >> .gitignore
git add .gitignore docs/
git commit -m "docs: confirm numeric DP indices against live hardware"
```

---

### Task #1: Migrate packaging and tooling to ESM / Homebridge v2

**Goal:** The plugin builds as ESM and its entry point loads under Node 24 without a CommonJS require.

**Files:**
- Modify: `package.json`, `tsconfig.json`, `eslint.config.mjs` → `eslint.config.js`, `.gitignore`
- Modify: `src/index.ts`, `src/platform.ts`, `src/platformAccessory.ts` (import extensions only)
- Create: `vitest.config.ts`, `.github/workflows/ci.yml`
- Delete: committed `dist/`

**Acceptance Criteria:**
- [ ] `package.json` has `"type": "module"`; engines `node ^22.10.0 || ^24.0.0`, `homebridge ^1.8.0 || ^2.0.0`
- [ ] `tsconfig.json` uses `module: nodenext`, `moduleResolution: nodenext`
- [ ] All relative imports carry `.js` extensions
- [ ] Version bumped to `2.0.0`; keyword `supports-hap` added
- [ ] Deps: `tuyapi ^7.7.1`, `zod ^4.4.3`, `@homebridge/plugin-ui-utils ^2.2.5`; devDeps include `vitest ^4.1.10`
- [ ] `dist/` removed from git tracking and added to `.gitignore`
- [ ] `files` array in package.json includes `dist` and `homebridge-ui`
- [ ] CI workflow runs lint + test + build on Node 22 and 24

**Verify:** `npm run lint && npm run build && node --input-type=module -e "await import('./dist/index.js')"` → exits 0 with no output.

**Steps:**

- [ ] **Step 1: Rewrite package.json**

```json
{
  "name": "homebridge-ventair-ceiling-fan",
  "displayName": "Homebridge Ventair Skyfan DC Ceiling Fan",
  "version": "2.0.0",
  "type": "module",
  "main": "dist/index.js",
  "engines": {
    "homebridge": "^1.8.0 || ^2.0.0",
    "node": "^22.10.0 || ^24.0.0"
  },
  "files": ["dist", "homebridge-ui", "config.schema.json", "README.md", "LICENSE"],
  "keywords": [
    "homebridge-plugin", "supports-hap", "skyfandc",
    "ceiling", "fan", "ceiling fan", "tuya", "ventair"
  ],
  "scripts": {
    "lint": "eslint . --max-warnings=0",
    "test": "vitest run",
    "build": "rimraf ./dist && tsc",
    "watch": "npm run build && npm link && nodemon",
    "prepublishOnly": "npm run lint && npm run test && npm run build"
  },
  "dependencies": {
    "@homebridge/plugin-ui-utils": "^2.2.5",
    "tuyapi": "^7.7.1",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/node": "^25.6.0",
    "eslint": "^10.3.0",
    "homebridge": "^2.0.0",
    "nodemon": "^3.1.14",
    "rimraf": "^6.1.3",
    "typescript": "^6.0.3",
    "typescript-eslint": "^8.59.2",
    "vitest": "^4.1.10"
  }
}
```

Keep the existing `repository`, `bugs`, `license`, `description`, `private` fields as they are.

These devDependency versions match the official `homebridge-plugin-template` as of this date,
which is the reference Homebridge validates plugins against. TypeScript 7.0.2 and ESLint 10.8
exist upstream; the caret ranges above will pick up 6.x and 10.x patches. Do not jump to
TypeScript 7 in this task — that is a separate migration with its own breakage surface.

- [ ] **Step 2: Update tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "rootDir": "src",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "declaration": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "sourceMap": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

`DOM` is dropped from `lib` — this is a Node plugin and the DOM types only mask mistakes.

- [ ] **Step 3: Add `.js` extensions to relative imports**

`nodenext` requires explicit extensions. In `src/index.ts`:

```ts
import { HomebridgeVentairCeilingFan } from './platform.js';
import { PLATFORM_NAME } from './settings.js';
```

Apply the same to `src/platform.ts` (`./settings.js`, `./platformAccessory.js`) and `src/platformAccessory.ts` (`./platform.js`).

- [ ] **Step 4: Remove the `Categories` value import**

This is the specific line that breaks ESM loading. In `src/platform.ts`, `Categories` is imported as a *value*, which compiles to `require('homebridge')`. Replace it with the HAP namespace already available on the API object.

Change the import to type-only:

```ts
import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
```

And at the usage site (currently `platform.ts:61`):

```ts
const accessory = new this.api.platformAccessory(device.name, uuid, this.api.hap.Categories.FAN);
```

Note `Logger` is also swapped for `Logging` here — `Logger` is the deprecated name.

- [ ] **Step 5: Convert the ESLint config to flat ESM**

Rename `eslint.config.mjs` to `eslint.config.js` (the package is now `"type": "module"`, so `.js` is already ESM) and add ignores:

```js
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'scripts/**', 'homebridge-ui/public/**'] },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
];
```

The `globals` dependency and the `files`/`languageOptions` blocks go — `typescript-eslint` handles the TS files and nothing here needs browser globals.

- [ ] **Step 6: Add vitest config**

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 7: Untrack dist and update .gitignore**

```bash
git rm -r --cached dist -q
printf 'dist/\nscripts/\ncoverage/\n' >> .gitignore
```

- [ ] **Step 8: Add CI**

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [22.x, 24.x]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: npm ci
      - run: npm run lint
      - run: npm run test
      - run: npm run build
```

- [ ] **Step 9: Install, build, and prove the ESM load**

```bash
rm -rf node_modules package-lock.json
npm install
npm run lint
npm run build
node --input-type=module -e "await import('./dist/index.js')"
```

Expected: all four commands exit 0. The last is the critical one — it is exactly what failed before this task.

If `import TuyAPI from 'tuyapi'` fails to typecheck under `nodenext`, it is because tuyapi ships an ambient `declare module 'tuyapi'` block. It resolves correctly via the package's `types: index.d.ts` field; if TypeScript still complains, add `"skipLibCheck": true` (already present) and confirm no `paths` override is interfering.

- [ ] **Step 10: Create CHANGELOG.md**

This file is created once here and appended to by every subsequent task.

```markdown
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
```

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "build: migrate to ESM for Homebridge v2

Homebridge v2 is ESM-only. The Categories value import compiled to
require('homebridge') and prevented the plugin loading at all.
Switches to api.hap.Categories, nodenext resolution, and Node 22/24."
```

---

### Task #3: Build dps.ts — single-source DPS mapping

**Goal:** One pure module owns the DPS table and every conversion, so speed/mode/brightness logic exists in exactly one place.

**Files:**
- Create: `src/dps.ts`, `test/dps.test.ts`

**Acceptance Criteria:**
- [ ] DPS table declared once; no conversion arithmetic anywhere else in the codebase
- [ ] Speed conversion covers steps 0–5 ↔ 0–100%
- [ ] Mode enum is exactly `nature | sleep | smart`
- [ ] `brightnessScale` is an explicit parameter, not a hardcoded constant
- [ ] Module imports nothing from `homebridge` or `tuyapi`

**Verify:** `npx vitest run test/dps.test.ts` → all tests pass.

**Steps:**

- [ ] **Step 1: Write the failing tests**

```ts
// test/dps.test.ts
import { describe, expect, it } from 'vitest';
import { DP, percentToStep, stepToPercent, toDps, toFanState } from '../src/dps.js';

describe('speed conversion', () => {
  it('round-trips every step', () => {
    for (let step = 0; step <= 5; step++) {
      expect(percentToStep(stepToPercent(step))).toBe(step);
    }
  });

  it('maps steps to the expected percentages', () => {
    expect([0, 1, 2, 3, 4, 5].map(stepToPercent)).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('clamps out-of-range percentages', () => {
    expect(percentToStep(-10)).toBe(0);
    expect(percentToStep(999)).toBe(5);
  });
});

describe('toFanState', () => {
  it('reads a full device payload', () => {
    const state = toFanState({
      [DP.power]: true,
      [DP.mode]: 'sleep',
      [DP.speed]: 3,
      [DP.direction]: 'reverse',
    }, { brightnessScale: 100 });

    expect(state).toEqual({
      power: true, mode: 'sleep', speedStep: 3, direction: 'reverse',
    });
  });

  it('ignores absent datapoints rather than inventing defaults', () => {
    expect(toFanState({ [DP.power]: false }, { brightnessScale: 100 })).toEqual({ power: false });
  });

  it('normalises mode case, since the device reports "Normal" but accepts "normal"', () => {
    expect(toFanState({ [DP.mode]: 'Normal' }, { brightnessScale: 100 }).mode).toBe('normal');
    expect(toFanState({ [DP.mode]: 'Sleep' }, { brightnessScale: 100 }).mode).toBe('sleep');
  });

  it('preserves an unrecognised mode rather than discarding it', () => {
    // The cloud enum was incomplete once already — dropping unknowns would have
    // silently discarded "Normal", the live value on all eight fans.
    expect(toFanState({ [DP.mode]: 'turbo' }, { brightnessScale: 100 }).mode).toBe('turbo');
  });

  it('treats an absent speed datapoint as unknown, not zero', () => {
    // Two of the eight fans omit DP 3 entirely.
    expect(toFanState({ [DP.power]: false }, { brightnessScale: 100 }).speedStep).toBeUndefined();
  });

  it('scales brightness from the device range to percent', () => {
    expect(toFanState({ [DP.lightBrightness]: 500 }, { brightnessScale: 1000 }).lightBrightness).toBe(50);
    expect(toFanState({ [DP.lightBrightness]: 50 }, { brightnessScale: 100 }).lightBrightness).toBe(50);
  });
});

describe('toDps', () => {
  it('writes speed as a step, not a percentage', () => {
    expect(toDps({ speedStep: 4 }, { brightnessScale: 100 })).toEqual({ [DP.speed]: 4 });
  });

  it('scales brightness back to the device range', () => {
    expect(toDps({ lightBrightness: 50 }, { brightnessScale: 1000 })).toEqual({ [DP.lightBrightness]: 500 });
  });

  it('emits only the keys present in the patch', () => {
    expect(Object.keys(toDps({ power: true }, { brightnessScale: 100 }))).toEqual([DP.power]);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run test/dps.test.ts`
Expected: FAIL — cannot resolve `../src/dps.js`.

- [ ] **Step 3: Implement dps.ts**

```ts
// src/dps.ts
export type DpValue = boolean | number | string;

/**
 * Numeric datapoint indices for the Ventair Skyfan DC (Tuya category `fs`).
 * Confirmed against live hardware in task #11 — see the design spec.
 */
export const DP = {
  power: '1',
  mode: '2',
  speed: '3',
  direction: '8',
  /** Present on the hardware but deliberately not implemented — see the spec. */
  countdown: '22',
  /** Unverified: no unit in this deployment has a light. */
  lightPower: '15',
  lightBrightness: '16',
} as const;

/**
 * Modes reachable over the LAN, confirmed by write probe both powered off and running:
 * the device accepts only "Normal" and "Sleep". Anything else — including the cloud's
 * "nature" and "smart" — comes back as "Sleep", consistent with the firmware resolving
 * the enum by index and defaulting unknowns to index 1.
 *
 * Kept as a plain string type, not a union: the cloud specification was already wrong
 * once, so unrecognised values are preserved rather than discarded.
 */
export const MODE_NORMAL = 'normal';
export const MODE_SLEEP = 'sleep';

export type FanMode = string;

/** The device expects capitalised mode strings, e.g. "Normal". */
export function toDeviceMode(mode: string): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1).toLowerCase();
}

export const DIRECTIONS = ['forward', 'reverse'] as const;
export type FanDirection = (typeof DIRECTIONS)[number];

/** The device reports speed 1-5; 0 is represented by the power datapoint being false. */
export const MAX_SPEED_STEP = 5;
const PERCENT_PER_STEP = 100 / MAX_SPEED_STEP;

/**
 * Devices with a light report brightness on their own scale. This deployment has no
 * light hardware, so the default is unverified — see the spec's light-support caveat.
 */
export const DEFAULT_BRIGHTNESS_SCALE = 100;

export interface DpsOptions {
  brightnessScale: number;
}

export interface FanState {
  power: boolean;
  mode: FanMode;
  speedStep: number;
  direction: FanDirection;
  lightPower: boolean;
  lightBrightness: number;
}

export function stepToPercent(step: number): number {
  return clamp(step, 0, MAX_SPEED_STEP) * PERCENT_PER_STEP;
}

export function percentToStep(percent: number): number {
  return clamp(Math.round(percent / PERCENT_PER_STEP), 0, MAX_SPEED_STEP);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Translate a raw device payload into partial state. Absent datapoints stay absent. */
export function toFanState(dps: Record<string, DpValue>, opts: DpsOptions): Partial<FanState> {
  const state: Partial<FanState> = {};

  if (typeof dps[DP.power] === 'boolean') {
    state.power = dps[DP.power];
  }
  if (typeof dps[DP.mode] === 'string') {
    // Lower-cased for internal comparison; unknown values pass through untouched.
    state.mode = dps[DP.mode].toLowerCase();
  }
  if (typeof dps[DP.speed] === 'number') {
    state.speedStep = clamp(dps[DP.speed], 0, MAX_SPEED_STEP);
  }
  if (isDirection(dps[DP.direction])) {
    state.direction = dps[DP.direction];
  }
  if (typeof dps[DP.lightPower] === 'boolean') {
    state.lightPower = dps[DP.lightPower];
  }
  if (typeof dps[DP.lightBrightness] === 'number') {
    state.lightBrightness = Math.round((dps[DP.lightBrightness] / opts.brightnessScale) * 100);
  }

  return state;
}

/** Translate a state patch into the datapoints to write. Only present keys are emitted. */
export function toDps(patch: Partial<FanState>, opts: DpsOptions): Record<string, DpValue> {
  const dps: Record<string, DpValue> = {};

  if (patch.power !== undefined) {
    dps[DP.power] = patch.power;
  }
  if (patch.mode !== undefined) {
    dps[DP.mode] = toDeviceMode(patch.mode);
  }
  if (patch.speedStep !== undefined) {
    dps[DP.speed] = clamp(patch.speedStep, 1, MAX_SPEED_STEP);
  }
  if (patch.direction !== undefined) {
    dps[DP.direction] = patch.direction;
  }
  if (patch.lightPower !== undefined) {
    dps[DP.lightPower] = patch.lightPower;
  }
  if (patch.lightBrightness !== undefined) {
    dps[DP.lightBrightness] = Math.round((patch.lightBrightness / 100) * opts.brightnessScale);
  }

  return dps;
}

function isDirection(v: DpValue | undefined): v is FanDirection {
  return typeof v === 'string' && (DIRECTIONS as readonly string[]).includes(v);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/dps.test.ts`
Expected: PASS, all cases green.

- [ ] **Step 5: Commit**

Add under `## [Unreleased]` → `### Changed`:

```markdown
- Consolidated the DPS mapping and speed conversion into a single pure module. It previously
  existed in three places that had to be kept in sync by hand.
```

```bash
git add src/dps.ts test/dps.test.ts CHANGELOG.md
git commit -m "feat: single-source DPS mapping module

The DPS table and speed conversion previously existed in three places
that had to be edited together. One pure module now owns them."
```

---

### Task #4: Add Zod config validation with skip-bad-device policy

**Goal:** Config is parsed into typed values, and one malformed device costs one fan rather than the whole bridge.

**Files:**
- Create: `src/config.ts`, `test/config.test.ts`
- Modify: `config.schema.json`

**Acceptance Criteria:**
- [ ] Device schema validates id, 16-char key, optional IPv4, protocol version enum
- [ ] `hasLight` defaults to `false` and is no longer required
- [ ] `exposeModeSwitches` defaults to `false`
- [ ] An invalid device is logged via `z.prettifyError()` and skipped; valid siblings still load
- [ ] Keys containing shell metacharacters survive parsing unmodified
- [ ] `config.schema.json` renders key as a password field with ip/version in an Advanced section

**Verify:** `npx vitest run test/config.test.ts` → all tests pass, including the 8-devices-one-corrupt case returning 7.

**Steps:**

- [ ] **Step 1: Write the failing tests**

```ts
// test/config.test.ts
import { describe, expect, it, vi } from 'vitest';
import { parseDevices } from '../src/config.js';

const log = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() });

// Fixtures are synthetic. Never paste a real local key into a test file.
const valid = {
  id: 'bf01000000000000000a',
  key: 'x'.repeat(16),
  name: 'Family Room Fan',
};

describe('parseDevices', () => {
  it('accepts a minimal valid device and applies defaults', () => {
    const [d] = parseDevices({ devices: [valid] }, log());
    expect(d.hasLight).toBe(false);
    expect(d.exposeModeSwitches).toBe(false);
    expect(d.version).toBe('3.3');
    expect(d.ip).toBeUndefined();
  });

  it('preserves keys containing shell metacharacters', () => {
    const key = 'a`b|c$d<e!f?g\'h';
    expect(key.length).toBe(15);
    const padded = key + 'i';
    const [d] = parseDevices({ devices: [{ ...valid, key: padded }] }, log());
    expect(d.key).toBe(padded);
  });

  it('skips one invalid device and keeps the rest', () => {
    const l = log();
    const devices = [
      valid,
      { ...valid, id: 'bf02000000000000000a', key: 'too-short' },
      { ...valid, id: 'bf03000000000000000a' },
    ];
    const parsed = parseDevices({ devices }, l);
    expect(parsed).toHaveLength(2);
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(l.warn.mock.calls[0].join(' ')).toMatch(/16 characters/);
  });

  it('returns empty and warns when devices is missing', () => {
    const l = log();
    expect(parseDevices({}, l)).toEqual([]);
    expect(l.warn).toHaveBeenCalled();
  });

  it('rejects an unsupported protocol version', () => {
    const l = log();
    expect(parseDevices({ devices: [{ ...valid, version: '9.9' }] }, l)).toHaveLength(0);
  });

  it('never logs the key', () => {
    const l = log();
    parseDevices({ devices: [{ ...valid, name: '' }] }, l);
    const logged = JSON.stringify(l.warn.mock.calls);
    expect(logged).not.toContain(valid.key);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 3: Implement config.ts**

```ts
// src/config.ts
import type { Logging } from 'homebridge';
import { z } from 'zod';

export const PROTOCOL_VERSIONS = ['3.1', '3.2', '3.3', '3.4', '3.5'] as const;

export const DeviceSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{16,26}$/i, 'Tuya device ID should be 16-26 hex characters'),
  key: z.string().length(16, 'Tuya local keys are exactly 16 characters'),
  name: z.string().min(1, 'Device name cannot be empty'),
  hasLight: z.boolean().default(false),
  exposeModeSwitches: z.boolean().default(false),
  ip: z.ipv4('Not a valid IPv4 address').optional(),
  version: z.enum(PROTOCOL_VERSIONS).default('3.3'),
});

export type VentairDevice = z.infer<typeof DeviceSchema>;

/**
 * Parse the `devices` array, dropping entries that fail validation.
 *
 * A single mistyped key must cost the user one fan, not the whole bridge — with eight
 * devices configured, failing the entire platform on one bad entry is the wrong trade.
 */
export function parseDevices(config: { devices?: unknown }, log: Pick<Logging, 'warn'>): VentairDevice[] {
  if (!Array.isArray(config.devices)) {
    log.warn('No devices configured. Add at least one fan in the plugin settings.');
    return [];
  }

  const devices: VentairDevice[] = [];

  for (const [index, raw] of config.devices.entries()) {
    const result = DeviceSchema.safeParse(raw);
    if (result.success) {
      devices.push(result.data);
      continue;
    }
    // Identify by name or position — never echo the key back into the log.
    const label = describe(raw, index);
    log.warn(`Skipping ${label} — invalid configuration:\n${z.prettifyError(result.error)}`);
  }

  return devices;
}

function describe(raw: unknown, index: number): string {
  const name = raw && typeof raw === 'object' && 'name' in raw ? (raw as { name: unknown }).name : undefined;
  return typeof name === 'string' && name.length > 0 ? `device "${name}"` : `device at position ${index + 1}`;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewrite config.schema.json**

```json
{
  "pluginAlias": "HomebridgeVentairCeilingFan",
  "pluginType": "platform",
  "singular": true,
  "customUi": true,
  "headerDisplay": "Control Ventair Skyfan DC ceiling fans locally over your network. Use the Scan button to find fans, or fetch local keys from your Tuya IoT account.",
  "schema": {
    "type": "object",
    "properties": {
      "name": {
        "title": "Name",
        "type": "string",
        "required": true,
        "default": "Skyfan DC Ceiling Fan"
      },
      "devices": {
        "type": "array",
        "title": "Fans",
        "items": {
          "type": "object",
          "properties": {
            "name": {
              "type": "string",
              "title": "Name",
              "required": true,
              "description": "Shown in the Home app, e.g. Lounge Room Fan"
            },
            "id": {
              "type": "string",
              "title": "Device ID",
              "required": true,
              "description": "Tuya device ID"
            },
            "key": {
              "type": "string",
              "title": "Local Key",
              "required": true,
              "format": "password",
              "description": "16-character Tuya local key"
            },
            "hasLight": {
              "type": "boolean",
              "title": "Fan has a light",
              "default": false,
              "description": "Enable only if your fan has an integrated light. Light support is currently untested."
            },
            "exposeModeSwitches": {
              "type": "boolean",
              "title": "Expose mode switches",
              "default": false,
              "description": "Adds Nature, Sleep and Smart switches to this fan in the Home app."
            },
            "ip": {
              "type": "string",
              "title": "IP Address",
              "required": false,
              "description": "Leave blank to discover automatically."
            },
            "version": {
              "type": "string",
              "title": "Protocol Version",
              "default": "3.3",
              "required": false,
              "oneOf": [
                { "title": "3.1", "enum": ["3.1"] },
                { "title": "3.2", "enum": ["3.2"] },
                { "title": "3.3", "enum": ["3.3"] },
                { "title": "3.4", "enum": ["3.4"] },
                { "title": "3.5", "enum": ["3.5"] }
              ]
            }
          }
        }
      }
    }
  },
  "layout": [
    { "key": "name" },
    {
      "key": "devices",
      "type": "array",
      "title": "Fans",
      "items": [
        "devices[].name",
        "devices[].id",
        "devices[].key",
        "devices[].hasLight",
        "devices[].exposeModeSwitches",
        {
          "type": "fieldset",
          "title": "Advanced",
          "expandable": true,
          "expanded": false,
          "items": ["devices[].ip", "devices[].version"]
        }
      ]
    }
  ]
}
```

- [ ] **Step 6: Commit**

Add under `## [Unreleased]`:

```markdown
### Added

- Config is now validated with Zod. Invalid device entries are reported with an actionable
  message and skipped, so one mistyped key no longer prevents the platform loading.

### Changed

- **BREAKING:** `hasLight` is no longer required and now defaults to `false`.
- Added `exposeModeSwitches` (default `false`).
- `ip` is now optional — leave it blank for automatic discovery.
```

```bash
git add src/config.ts test/config.test.ts config.schema.json CHANGELOG.md
git commit -m "feat: validate plugin config with Zod

Config was previously assigned through unchecked, with ip and version
read untyped off accessory.context. Invalid devices are now skipped
with an actionable message instead of loading as undefined."
```

---

### Task #5: Build the TuyaDevice seam and reconnect supervisor

**Goal:** tuyapi is confined to one file, and the overlapping-reconnect bug is fixed.

**Files:**
- Create: `src/tuya/device.ts`, `src/tuya/tuyapi.ts`, `test/tuyapi.test.ts`

**Acceptance Criteria:**
- [ ] `TuyaDevice` interface defined; `FakeTuyaDevice` implements it for tests
- [ ] Only `src/tuya/tuyapi.ts` imports `tuyapi`
- [ ] Simultaneous `error` and `disconnected` events produce exactly one connect attempt
- [ ] Backoff grows exponentially from 1s, capped at 60s, with jitter
- [ ] `disconnect()` stops all further retries
- [ ] Writes are batched into a single multi-DP `set` call
- [ ] The local key is never logged

**Verify:** `npx vitest run test/tuyapi.test.ts` → all tests pass.

**Steps:**

- [ ] **Step 1: Define the interface and the fake**

```ts
// src/tuya/device.ts
import type { DpValue } from '../dps.js';

export type DpsListener = (dps: Record<string, DpValue>) => void;

/**
 * Everything the plugin needs from a Tuya transport.
 *
 * The accessory depends only on this, never on tuyapi directly — tuyapi's author has
 * stopped active development, so the concrete implementation must stay swappable.
 */
export interface TuyaDevice {
  readonly connected: boolean;
  connect(): Promise<void>;
  disconnect(): void;
  set(dps: Record<string, DpValue>): Promise<void>;
  get(): Promise<Record<string, DpValue>>;
  onDps(listener: DpsListener): void;
  onConnected(listener: () => void): void;
  onDisconnected(listener: () => void): void;
}

/** In-memory stand-in used by the accessory tests. No network, no timers. */
export class FakeTuyaDevice implements TuyaDevice {
  connected = false;
  state: Record<string, DpValue> = {};
  readonly writes: Record<string, DpValue>[] = [];

  private dpsListeners: DpsListener[] = [];
  private connectedListeners: (() => void)[] = [];
  private disconnectedListeners: (() => void)[] = [];

  async connect(): Promise<void> {
    this.connected = true;
    this.connectedListeners.forEach(l => l());
  }

  disconnect(): void {
    this.connected = false;
    this.disconnectedListeners.forEach(l => l());
  }

  async set(dps: Record<string, DpValue>): Promise<void> {
    this.writes.push(dps);
    Object.assign(this.state, dps);
  }

  async get(): Promise<Record<string, DpValue>> {
    return { ...this.state };
  }

  onDps(l: DpsListener): void {
    this.dpsListeners.push(l);
  }

  onConnected(l: () => void): void {
    this.connectedListeners.push(l);
  }

  onDisconnected(l: () => void): void {
    this.disconnectedListeners.push(l);
  }

  /** Test helper: simulate the device pushing state. */
  emitDps(dps: Record<string, DpValue>): void {
    Object.assign(this.state, dps);
    this.dpsListeners.forEach(l => l(dps));
  }
}
```

- [ ] **Step 2: Write the failing reconnect tests**

```ts
// test/tuyapi.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connect = vi.fn();
const find = vi.fn();
const disconnect = vi.fn();
const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};

vi.mock('tuyapi', () => ({
  default: class {
    connect = connect;
    find = find;
    disconnect = disconnect;
    isConnected = () => false;
    get = vi.fn().mockResolvedValue({ dps: {} });
    set = vi.fn().mockResolvedValue({ dps: {} });
    on(event: string, fn: (...a: unknown[]) => void) {
      (handlers[event] ??= []).push(fn);
      return this;
    }
  },
}));

const { TuyapiDevice } = await import('../src/tuya/tuyapi.js');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const opts = { id: 'abc123', key: 'x'.repeat(16), version: '3.3' as const };

function fire(event: string) {
  handlers[event]?.forEach(fn => fn(new Error('boom')));
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.keys(handlers).forEach(k => delete handlers[k]);
  connect.mockReset().mockResolvedValue(true);
  find.mockReset().mockResolvedValue(true);
  disconnect.mockReset();
  Object.values(log).forEach(m => m.mockReset());
});

afterEach(() => vi.useRealTimers());

describe('reconnect supervision', () => {
  it('collapses simultaneous error and disconnected into one attempt', async () => {
    const d = new TuyapiDevice(opts, log);
    connect.mockImplementation(() => new Promise(() => {})); // never settles
    d.connect();
    fire('error');
    fire('disconnected');
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially and caps at 60s', async () => {
    const d = new TuyapiDevice(opts, log);
    connect.mockRejectedValue(new Error('refused'));
    d.connect();
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(d.nextDelayMs).toBeLessThanOrEqual(60_000);
    expect(connect.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops retrying after disconnect', async () => {
    const d = new TuyapiDevice(opts, log);
    connect.mockRejectedValue(new Error('refused'));
    d.connect();
    await vi.advanceTimersByTimeAsync(2000);
    const before = connect.mock.calls.length;
    d.disconnect();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connect.mock.calls.length).toBe(before);
  });

  it('never logs the key', async () => {
    const d = new TuyapiDevice(opts, log);
    connect.mockRejectedValue(new Error('refused'));
    d.connect();
    await vi.advanceTimersByTimeAsync(5000);
    const all = JSON.stringify(Object.values(log).map(m => m.mock.calls));
    expect(all).not.toContain(opts.key);
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `npx vitest run test/tuyapi.test.ts`
Expected: FAIL — cannot resolve `../src/tuya/tuyapi.js`.

- [ ] **Step 4: Implement the adapter**

```ts
// src/tuya/tuyapi.ts
import type { Logging } from 'homebridge';
import TuyAPI from 'tuyapi';
import type { DpValue } from '../dps.js';
import type { DpsListener, TuyaDevice } from './device.js';

export interface TuyapiOptions {
  id: string;
  key: string;
  version: string;
  ip?: string;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

export class TuyapiDevice implements TuyaDevice {
  private readonly device: TuyAPI;
  private readonly dpsListeners: DpsListener[] = [];
  private readonly connectedListeners: (() => void)[] = [];
  private readonly disconnectedListeners: (() => void)[] = [];

  /** Non-null while a connect attempt is in flight — the guard against overlapping loops. */
  private inFlight: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private attempt = 0;

  constructor(private readonly opts: TuyapiOptions, private readonly log: Logging) {
    this.device = new TuyAPI({
      id: opts.id,
      key: opts.key,
      ip: opts.ip,
      version: opts.version,
      // NOT issueRefreshOnConnect: it makes tuyapi call refresh() internally on every
      // connect, and refresh() hangs for 20s on this hardware. The timeout then emits
      // 'error', which would route straight into the reconnect path — every healthy
      // connection would schedule a spurious reconnect. We call get() ourselves instead.
    });

    // Both events previously called connect() directly, which allowed two retry
    // loops to run concurrently. They now funnel through the same guarded path.
    this.device.on('disconnected', () => {
      this.connectedState = false;
      this.disconnectedListeners.forEach(l => l());
      this.scheduleReconnect('disconnected');
    });

    this.device.on('error', (error: Error) => {
      this.log.debug(`[${this.opts.id}] transport error: ${error.message}`);
      this.scheduleReconnect('error');
    });

    this.device.on('connected', () => {
      this.connectedState = true;
      this.attempt = 0;
      this.connectedListeners.forEach(l => l());
    });

    const forward = (data: { dps?: Record<string, DpValue> }) => {
      if (data?.dps) {
        this.dpsListeners.forEach(l => l(data.dps as Record<string, DpValue>));
      }
    };
    this.device.on('data', forward);
    this.device.on('dp-refresh', forward);
  }

  private connectedState = false;

  get connected(): boolean {
    return this.connectedState;
  }

  /** Exposed for tests to assert backoff growth. */
  get nextDelayMs(): number {
    return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** this.attempt);
  }

  async connect(): Promise<void> {
    if (this.stopped || this.inFlight) {
      return this.inFlight ?? undefined;
    }
    this.inFlight = this.attemptConnect().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async attemptConnect(): Promise<void> {
    try {
      if (!this.opts.ip) {
        await this.device.find();
      }
      await this.device.connect();
      this.log.info(`[${this.opts.id}] connected`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.attempt++;
      const delay = jitter(this.nextDelayMs);
      this.log.warn(`[${this.opts.id}] connect failed (${message}); retrying in ${Math.round(delay / 1000)}s`);
      this.armRetry(delay);
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.inFlight || this.retryTimer) {
      return;
    }
    this.log.debug(`[${this.opts.id}] scheduling reconnect (${reason})`);
    this.armRetry(jitter(this.nextDelayMs));
  }

  private armRetry(delay: number): void {
    if (this.stopped || this.retryTimer) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.connectedState = false;
    this.device.disconnect();
  }

  /** One batched write rather than a sequence of single-DP calls. */
  async set(dps: Record<string, DpValue>): Promise<void> {
    if (Object.keys(dps).length === 0) {
      return;
    }
    await this.device.set({ multiple: true, data: dps, shouldWaitForResponse: false });
  }

  async get(): Promise<Record<string, DpValue>> {
    const result = await this.device.get({ schema: true });
    if (result && typeof result === 'object' && 'dps' in result) {
      return (result as { dps: Record<string, DpValue> }).dps;
    }
    return {};
  }

  onDps(l: DpsListener): void {
    this.dpsListeners.push(l);
  }

  onConnected(l: () => void): void {
    this.connectedListeners.push(l);
  }

  onDisconnected(l: () => void): void {
    this.disconnectedListeners.push(l);
  }
}

/** Spread retries so eight fans reconnecting after a network blip don't sync up. */
function jitter(delay: number): number {
  return delay * (0.5 + Math.random() / 2);
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/tuyapi.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

Add under `## [Unreleased]`:

```markdown
### Fixed

- Fixed a reconnect storm. The `error` and `disconnected` handlers both called `connect()`
  with no in-flight guard and no backoff, so a single failure could spawn overlapping retry
  loops. Retries are now serialised with exponential backoff and jitter, capped at 60s.

### Changed

- Device writes are batched into a single multi-datapoint call instead of a sequence of
  single-datapoint writes.
- tuyapi is now confined behind an internal interface so it can be replaced without
  touching the rest of the plugin.
```

```bash
git add src/tuya test/tuyapi.test.ts CHANGELOG.md
git commit -m "feat: isolate tuyapi behind TuyaDevice and fix reconnect storm

error and disconnected both called connect() with no in-flight guard
and no backoff, so one failure could spawn overlapping retry loops.
With eight fans that compounds. Writes are now batched into one call."
```

---

### Task #6: Add UDP discovery module

**Goal:** Resolve device IP and protocol version at runtime so users supply only id, key and name.

**Files:**
- Create: `src/tuya/discovery.ts`, `test/discovery.test.ts`

**Acceptance Criteria:**
- [ ] Listens on UDP 6666 and 6667 and decodes both plaintext and AES-ECB payloads
- [ ] Returns `{ id, ip, version }` per device, deduplicated
- [ ] Resolves after a caller-supplied timeout and closes every socket
- [ ] A bind failure on one port does not prevent the other from working
- [ ] Callable from both the platform and the settings UI server

**Verify:** `npx vitest run test/discovery.test.ts` passes; then run against the live network from the container and confirm all 8 known device IDs appear.

**Steps:**

- [ ] **Step 1: Write the failing tests**

Decoding is the part worth testing in isolation; the socket handling gets verified live.

```ts
// test/discovery.test.ts
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeBroadcast } from '../src/tuya/discovery.js';

const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

function frame(payload: Buffer): Buffer {
  // 20-byte header + payload + 8-byte CRC/suffix, matching Tuya's 55AA framing
  return Buffer.concat([Buffer.alloc(20), payload, Buffer.alloc(8)]);
}

const announcement = { gwId: 'bf01000000000000000a', ip: '192.0.2.11', version: '3.3' };

describe('decodeBroadcast', () => {
  it('decodes a plaintext announcement', () => {
    const buf = frame(Buffer.from(JSON.stringify(announcement)));
    expect(decodeBroadcast(buf)).toEqual(announcement);
  });

  it('decodes an AES-ECB encrypted announcement', () => {
    const c = crypto.createCipheriv('aes-128-ecb', UDP_KEY, null);
    const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(announcement))), c.final()]);
    expect(decodeBroadcast(frame(body))).toEqual(announcement);
  });

  it('returns null for undecodable rubbish rather than throwing', () => {
    expect(decodeBroadcast(frame(Buffer.from('not json at all')))).toBeNull();
  });

  it('returns null when the frame is too short to contain a payload', () => {
    expect(decodeBroadcast(Buffer.alloc(10))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run test/discovery.test.ts`
Expected: FAIL — cannot resolve `../src/tuya/discovery.js`.

- [ ] **Step 3: Implement discovery.ts**

```ts
// src/tuya/discovery.ts
import dgram from 'node:dgram';
import crypto from 'node:crypto';

/**
 * Tuya broadcasts device announcements on these ports. The AES key is a published
 * constant shared by every Tuya device — it protects nothing and is documented in
 * tinytuya and localtuya. It is not a secret and grants no device control.
 */
const UDP_PORTS = [6666, 6667] as const;
const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

const HEADER_BYTES = 20;
const SUFFIX_BYTES = 8;

export interface DiscoveredDevice {
  id: string;
  ip: string;
  version: string;
}

/** Decode one broadcast frame. Returns null when the payload isn't a device announcement. */
export function decodeBroadcast(buf: Buffer): DiscoveredDevice | null {
  if (buf.length <= HEADER_BYTES + SUFFIX_BYTES) {
    return null;
  }
  const body = buf.subarray(HEADER_BYTES, buf.length - SUFFIX_BYTES);
  const parsed = tryParse(body) ?? tryParse(tryDecrypt(body));
  if (!parsed?.gwId || !parsed.ip) {
    return null;
  }
  return { id: String(parsed.gwId), ip: String(parsed.ip), version: String(parsed.version ?? '3.3') };
}

function tryParse(body: Buffer | null): Record<string, unknown> | null {
  if (!body) {
    return null;
  }
  try {
    return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function tryDecrypt(body: Buffer): Buffer | null {
  try {
    const d = crypto.createDecipheriv('aes-128-ecb', UDP_KEY, null);
    return Buffer.concat([d.update(body), d.final()]);
  } catch {
    return null;
  }
}

/**
 * Listen for broadcasts and return everything heard within `timeoutMs`.
 * Devices announce every few seconds, so 10s is generally ample.
 */
export function discover(timeoutMs = 10_000): Promise<DiscoveredDevice[]> {
  return new Promise(resolve => {
    const found = new Map<string, DiscoveredDevice>();
    const sockets: dgram.Socket[] = [];

    for (const port of UDP_PORTS) {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      // A port already in use must not take down the other listener.
      socket.on('error', () => socket.close());
      socket.on('message', msg => {
        const device = decodeBroadcast(msg);
        if (device) {
          found.set(device.id, device);
        }
      });
      try {
        socket.bind(port);
        sockets.push(socket);
      } catch {
        // ignore — the other port may still work
      }
    }

    setTimeout(() => {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          // already closed
        }
      }
      resolve([...found.values()]);
    }, timeoutMs).unref?.();
  });
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/discovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify against the live network**

Discovery must run where the fans are — the Homebridge container, which uses host networking.

```bash
npm run build
sshpass -p "$UNRAID_PW" scp dist/tuya/discovery.js root@192.0.2.10:/tmp/
sshpass -p "$UNRAID_PW" ssh root@192.0.2.10 \
  'docker cp /tmp/discovery.js homebridge:/tmp/ && docker exec homebridge node -e "
    import(\"/tmp/discovery.js\").then(async m => console.log(await m.discover(15000)))
  "'
```

Expected: all 8 known device IDs, with IPs matching the room map in the spec.

- [ ] **Step 6: Commit**

Add under `## [Unreleased]` → `### Added`:

```markdown
- Automatic device discovery over the local network. The plugin now resolves each fan's IP
  address and protocol version at runtime, so only id, key and name need configuring.
```

```bash
git add src/tuya/discovery.ts test/discovery.test.ts CHANGELOG.md
git commit -m "feat: UDP device discovery

Resolves IP and protocol version at runtime so users need only supply
id, key and name — sixteen fewer hand-typed fields across eight fans."
```

---

### Task #7: Rewrite platform.ts — lifecycle and stale accessory cleanup

**Goal:** The platform validates config, resolves discovery, and removes accessories that are no longer configured.

**Files:**
- Modify: `src/platform.ts`, `src/index.ts`
- Create: `test/platform.test.ts`

**Acceptance Criteria:**
- [ ] Accessories tracked in a `Map`, with a `discoveredCacheUUIDs` list
- [ ] Accessories absent from config are unregistered — this never happened before
- [ ] Uses `Logging`, not the deprecated `Logger`
- [ ] Devices without a configured `ip` get one from discovery before connecting
- [ ] A device that discovery cannot resolve still registers and retries in the background
- [ ] `discoverDevices` is `async` and its rejection is handled, not left floating

**Verify:** `npx vitest run test/platform.test.ts` → passes, including the stale-accessory unregister case.

**Steps:**

- [ ] **Step 1: Write the failing test**

```ts
// test/platform.test.ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/tuya/discovery.js', () => ({
  discover: vi.fn().mockResolvedValue([{ id: 'a'.repeat(20), ip: '192.0.2.11', version: '3.3' }]),
}));

const { HomebridgeVentairCeilingFan } = await import('../src/platform.js');

function harness() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), log: vi.fn() };
  const handlers: Record<string, () => void> = {};
  const api = {
    hap: {
      Service: { AccessoryInformation: 'info', Fanv2: 'fan', Lightbulb: 'light', Switch: 'switch' },
      Characteristic: {},
      Categories: { FAN: 3 },
      uuid: { generate: (s: string) => `uuid-${s}` },
    },
    on: (e: string, fn: () => void) => {
      handlers[e] = fn;
    },
    platformAccessory: class {
      context: Record<string, unknown> = {};
      services: unknown[] = [];
      constructor(public displayName: string, public UUID: string) {}
      getService() {
        return undefined;
      }
      addService() {
        return { setCharacteristic: () => ({ setCharacteristic: () => ({}) }), getCharacteristic: () => ({ onSet: () => ({ onGet: () => ({}) }), onGet: () => ({}) }) };
      }
    },
    registerPlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
  };
  return { log, api, handlers };
}

const device = { id: 'a'.repeat(20), key: 'k'.repeat(16), name: 'Family Room Fan' };

describe('platform lifecycle', () => {
  it('unregisters accessories no longer present in config', async () => {
    const { log, api, handlers } = harness();
    const platform = new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [device] } as never, api as never);

    const stale = { UUID: 'uuid-gone', displayName: 'Removed Fan', context: {} };
    platform.configureAccessory(stale as never);

    await handlers.didFinishLaunching?.();
    await vi.waitFor(() => expect(api.unregisterPlatformAccessories).toHaveBeenCalled());

    const [, , removed] = api.unregisterPlatformAccessories.mock.calls[0];
    expect(removed).toEqual([stale]);
  });

  it('registers a configured device that has no cached accessory', async () => {
    const { log, api, handlers } = harness();
    new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [device] } as never, api as never);
    await handlers.didFinishLaunching?.();
    await vi.waitFor(() => expect(api.registerPlatformAccessories).toHaveBeenCalled());
  });

  it('registers nothing when every device is invalid', async () => {
    const { log, api, handlers } = harness();
    new HomebridgeVentairCeilingFan(log as never, { platform: 'x', devices: [{ ...device, key: 'short' }] } as never, api as never);
    await handlers.didFinishLaunching?.();
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run test/platform.test.ts`
Expected: FAIL — the current platform has no discovery and never unregisters.

- [ ] **Step 3: Rewrite platform.ts**

```ts
// src/platform.ts
import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { CeilingFanAccessory } from './accessory.js';
import { parseDevices, type VentairDevice } from './config.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { discover } from './tuya/discovery.js';
import { TuyapiDevice } from './tuya/tuyapi.js';

export class HomebridgeVentairCeilingFan implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  private readonly discoveredCacheUUIDs: string[] = [];
  private readonly devices: VentairDevice[];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.devices = parseDevices(config as { devices?: unknown }, log);

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      // Rejections here would otherwise be an unhandled promise on the bridge.
      this.discoverDevices().catch(error => {
        this.log.error('Device setup failed:', error instanceof Error ? error.message : error);
      });
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  async discoverDevices(): Promise<void> {
    if (this.devices.length === 0) {
      return;
    }

    const addresses = await this.resolveAddresses();

    for (const device of this.devices) {
      const uuid = this.api.hap.uuid.generate(device.id);
      const ip = device.ip ?? addresses.get(device.id);

      if (!ip) {
        // Not fatal: tuyapi's own find() retries in the background.
        this.log.warn(`Could not discover an address for "${device.name}"; it will keep retrying.`);
      }

      const transport = new TuyapiDevice({ id: device.id, key: device.key, version: device.version, ip }, this.log);

      const existing = this.accessories.get(uuid);
      if (existing) {
        this.log.info('Restoring accessory from cache:', existing.displayName);
        existing.context.device = device;
        new CeilingFanAccessory(this, existing, device, transport);
      } else {
        this.log.info('Adding new ceiling fan:', device.name);
        const accessory = new this.api.platformAccessory(device.name, uuid, this.api.hap.Categories.FAN);
        accessory.context.device = device;
        new CeilingFanAccessory(this, accessory, device, transport);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      this.discoveredCacheUUIDs.push(uuid);
    }

    this.removeStaleAccessories();
  }

  /** Only run discovery if at least one device is missing an explicit address. */
  private async resolveAddresses(): Promise<Map<string, string>> {
    if (this.devices.every(d => d.ip)) {
      return new Map();
    }
    this.log.debug('Scanning for Tuya devices on the local network...');
    const found = await discover();
    this.log.debug(`Discovery found ${found.length} device(s).`);
    return new Map(found.map(d => [d.id, d.ip]));
  }

  /**
   * Accessories dropped from config were previously left registered forever,
   * leaving dead tiles in the Home app.
   */
  private removeStaleAccessories(): void {
    const stale = [...this.accessories.entries()]
      .filter(([uuid]) => !this.discoveredCacheUUIDs.includes(uuid))
      .map(([, accessory]) => accessory);

    if (stale.length === 0) {
      return;
    }

    for (const accessory of stale) {
      this.log.info('Removing accessory no longer in config:', accessory.displayName);
      this.accessories.delete(accessory.UUID);
    }
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/platform.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Add under `## [Unreleased]` → `### Fixed`:

```markdown
- Accessories removed from the config are now unregistered. Previously they stayed registered
  forever, leaving dead tiles in the Home app.
```

```bash
git add src/platform.ts src/index.ts test/platform.test.ts CHANGELOG.md
git commit -m "feat: platform lifecycle with discovery and stale cleanup

Accessories removed from config were never unregistered, leaving dead
tiles in the Home app. Adds runtime IP discovery and Map-based tracking."
```

---

### Task #8: Rewrite accessory.ts — corrected HomeKit modelling

**Goal:** The HomeKit surface matches what the hardware actually does, and stops reporting stale state for offline fans.

**Files:**
- Create: `src/accessory.ts`, `test/accessory.test.ts`
- Delete: `src/platformAccessory.ts`

**Acceptance Criteria:**
- [ ] `SwingMode` removed; `TargetFanState` deliberately not used
- [ ] Mode exposed as three mutually-exclusive `Switch` services behind `exposeModeSwitches`
- [ ] Selecting one mode switch clears the other two; switching off the active mode is a no-op
- [ ] Light service retained, named `"<name> Light"`, only when `hasLight`
- [ ] `ConfiguredName` set on every service
- [ ] `onGet` throws `SERVICE_COMMUNICATION_FAILURE` while disconnected
- [ ] `Model` is `Skyfan DC`; `FirmwareRevision` set
- [ ] Per-DPS updates log at `debug`
- [ ] Imports `TuyaDevice`, never `tuyapi`
- [ ] `countdown_set` deliberately not implemented

**Verify:** `npx vitest run test/accessory.test.ts` → all pass, including mutual exclusion and the offline-throw case.

**Steps:**

- [ ] **Step 1: Write the failing tests**

```ts
// test/accessory.test.ts
import { describe, expect, it, vi } from 'vitest';
import { DP } from '../src/dps.js';
import { FakeTuyaDevice } from '../src/tuya/device.js';
import { CeilingFanAccessory } from '../src/accessory.js';

// Minimal HAP doubles: record handlers so tests can invoke them directly.
function harness(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, { onSet?: (v: unknown) => Promise<void>; onGet?: () => unknown }>();
  const characteristic = (key: string) => {
    const entry = handlers.get(key) ?? {};
    handlers.set(key, entry);
    const chain = {
      onSet(fn: (v: unknown) => Promise<void>) { entry.onSet = fn; return chain; },
      onGet(fn: () => unknown) { entry.onGet = fn; return chain; },
      setProps() { return chain; },
      updateValue() { return chain; },
    };
    return chain;
  };
  const service = (name: string) => ({
    setCharacteristic() { return service(name); },
    getCharacteristic(c: string) { return characteristic(`${name}.${c}`); },
    updateCharacteristic: vi.fn(),
    displayName: name,
  });

  const platform = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    Service: { AccessoryInformation: 'Info', Fanv2: 'Fanv2', Lightbulb: 'Lightbulb', Switch: 'Switch' },
    Characteristic: {
      Manufacturer: 'Manufacturer', Model: 'Model', Name: 'Name', ConfiguredName: 'ConfiguredName',
      SerialNumber: 'SerialNumber', FirmwareRevision: 'FirmwareRevision',
      Active: Object.assign('Active', { ACTIVE: 1, INACTIVE: 0 }),
      RotationSpeed: 'RotationSpeed',
      RotationDirection: Object.assign('RotationDirection', { CLOCKWISE: 0, COUNTER_CLOCKWISE: 1 }),
      On: 'On', Brightness: 'Brightness',
    },
    api: { hap: { HapStatusError: class extends Error {}, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } } },
  };

  const accessory = {
    context: {} as Record<string, unknown>,
    getService: () => undefined,
    addService: (t: string, name?: string) => service(name ?? t),
    getServiceById: () => undefined,
    removeService: vi.fn(),
  };

  const device = { id: 'a'.repeat(20), key: 'k'.repeat(16), name: 'Family Room Fan', hasLight: false, exposeModeSwitches: false, version: '3.3' as const, ...overrides };
  return { platform, accessory, device, handlers };
}

describe('fan control', () => {
  it('turning speed to 0 powers the fan off', async () => {
    const { platform, accessory, device, handlers } = harness();
    const transport = new FakeTuyaDevice();
    await transport.connect();
    new CeilingFanAccessory(platform as never, accessory as never, device as never, transport);

    await handlers.get('Fanv2.RotationSpeed')?.onSet?.(0);
    expect(transport.state[DP.power]).toBe(false);
  });

  it('powering on from a stopped state restores step 1', async () => {
    const { platform, accessory, device, handlers } = harness();
    const transport = new FakeTuyaDevice();
    await transport.connect();
    new CeilingFanAccessory(platform as never, accessory as never, device as never, transport);

    await handlers.get('Fanv2.Active')?.onSet?.(1);
    expect(transport.state[DP.power]).toBe(true);
    expect(transport.state[DP.speed]).toBe(1);
  });

  it('throws while disconnected instead of reporting stale state', async () => {
    const { platform, accessory, device, handlers } = harness();
    const transport = new FakeTuyaDevice(); // never connected
    new CeilingFanAccessory(platform as never, accessory as never, device as never, transport);

    expect(() => handlers.get('Fanv2.Active')?.onGet?.()).toThrow();
  });

  it('sleep switch on writes Sleep, off writes Normal', async () => {
    const { platform, accessory, device, handlers } = harness({ exposeModeSwitches: true });
    const transport = new FakeTuyaDevice();
    await transport.connect();
    new CeilingFanAccessory(platform as never, accessory as never, device as never, transport);

    // Device accepts only Normal and Sleep, and requires capitalised strings.
    await handlers.get('Sleep.On')?.onSet?.(true);
    expect(transport.state[DP.mode]).toBe('Sleep');

    await handlers.get('Sleep.On')?.onSet?.(false);
    expect(transport.state[DP.mode]).toBe('Normal');
  });

  it('exposes no mode switch when exposeModeSwitches is false', async () => {
    const { platform, accessory, device, handlers } = harness({ exposeModeSwitches: false });
    const transport = new FakeTuyaDevice();
    await transport.connect();
    new CeilingFanAccessory(platform as never, accessory as never, device as never, transport);

    expect(handlers.get('Sleep.On')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run test/accessory.test.ts`
Expected: FAIL — cannot resolve `../src/accessory.js`.

- [ ] **Step 3: Implement accessory.ts**

```ts
// src/accessory.ts
import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { VentairDevice } from './config.js';
import { DEFAULT_BRIGHTNESS_SCALE, MODE_NORMAL, MODE_SLEEP, type FanState, percentToStep, stepToPercent, toDps, toFanState } from './dps.js';
import type { HomebridgeVentairCeilingFan } from './platform.js';
import type { TuyaDevice } from './tuya/device.js';

export class CeilingFanAccessory {
  private readonly fan: Service;
  private readonly light?: Service;
  private sleepSwitch?: Service;

  private readonly state: FanState = {
    power: false,
    mode: MODE_NORMAL,
    speedStep: 0,
    direction: 'forward',
    lightPower: false,
    lightBrightness: 100,
  };

  private readonly dpsOptions = { brightnessScale: DEFAULT_BRIGHTNESS_SCALE };

  constructor(
    private readonly platform: HomebridgeVentairCeilingFan,
    private readonly accessory: PlatformAccessory,
    private readonly device: VentairDevice,
    private readonly transport: TuyaDevice,
  ) {
    const { Characteristic, Service: S } = this.platform;

    this.accessory.getService(S.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Ventair')
      .setCharacteristic(Characteristic.Model, 'Skyfan DC')
      .setCharacteristic(Characteristic.SerialNumber, device.id)
      .setCharacteristic(Characteristic.FirmwareRevision, '2.0.0');

    this.fan = this.accessory.getService(S.Fanv2) ?? this.accessory.addService(S.Fanv2, device.name);
    this.fan.setCharacteristic(Characteristic.Name, device.name);
    this.fan.setCharacteristic(Characteristic.ConfiguredName, device.name);

    this.fan.getCharacteristic(Characteristic.Active)
      .onSet(v => this.setActive(v))
      .onGet(() => this.read(() => (this.state.power ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE)));

    this.fan.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 20 })
      .onSet(v => this.setSpeed(v))
      .onGet(() => this.read(() => (this.state.power ? stepToPercent(this.state.speedStep) : 0)));

    this.fan.getCharacteristic(Characteristic.RotationDirection)
      .onSet(v => this.setDirection(v))
      .onGet(() => this.read(() => (
        this.state.direction === 'forward'
          ? Characteristic.RotationDirection.CLOCKWISE
          : Characteristic.RotationDirection.COUNTER_CLOCKWISE
      )));

    if (device.hasLight) {
      const lightName = `${device.name} Light`;
      this.light = this.accessory.getService(S.Lightbulb) ?? this.accessory.addService(S.Lightbulb, lightName);
      this.light.setCharacteristic(Characteristic.Name, lightName);
      this.light.setCharacteristic(Characteristic.ConfiguredName, lightName);

      this.light.getCharacteristic(Characteristic.On)
        .onSet(v => this.write({ lightPower: v as boolean }))
        .onGet(() => this.read(() => this.state.lightPower));

      this.light.getCharacteristic(Characteristic.Brightness)
        .onSet(v => this.write({ lightBrightness: v as number }))
        .onGet(() => this.read(() => this.state.lightBrightness));
    }

    if (device.exposeModeSwitches) {
      // One switch: the hardware has exactly two reachable modes. On = Sleep, off = Normal.
      const label = 'Sleep';
      this.sleepSwitch = this.accessory.addService(S.Switch, label);
      this.sleepSwitch.setCharacteristic(Characteristic.Name, label);
      this.sleepSwitch.setCharacteristic(Characteristic.ConfiguredName, `${device.name} Sleep`);
      this.sleepSwitch.getCharacteristic(Characteristic.On)
        .onSet(v => this.write({ mode: v ? MODE_SLEEP : MODE_NORMAL }).then(() => this.syncModeSwitch()))
        .onGet(() => this.read(() => this.state.mode === MODE_SLEEP));
    }

    this.transport.onDps(dps => this.applyUpdate(dps));
    this.transport.onConnected(() => void this.refresh());
    this.transport.onDisconnected(() => this.platform.log.debug(`[${device.name}] disconnected`));

    void this.transport.connect();
  }

  /** HomeKit should show "No Response" rather than a stale value we can't vouch for. */
  private read<T>(fn: () => T): T {
    if (!this.transport.connected) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return fn();
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const on = value === this.platform.Characteristic.Active.ACTIVE;
    if (!on) {
      await this.write({ power: false });
      this.fan.updateCharacteristic(this.platform.Characteristic.RotationSpeed, 0);
      return;
    }
    // Coming on from a standstill needs a speed, or the fan turns on and does nothing.
    const speedStep = this.state.speedStep > 0 ? this.state.speedStep : 1;
    await this.write({ power: true, speedStep });
    this.fan.updateCharacteristic(this.platform.Characteristic.RotationSpeed, stepToPercent(speedStep));
  }

  private async setSpeed(value: CharacteristicValue): Promise<void> {
    const step = percentToStep(value as number);
    if (step === 0) {
      await this.write({ power: false });
      this.fan.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.INACTIVE);
      return;
    }
    await this.write({ power: true, speedStep: step });
    this.fan.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.ACTIVE);
  }

  private async setDirection(value: CharacteristicValue): Promise<void> {
    const direction = value === this.platform.Characteristic.RotationDirection.CLOCKWISE ? 'forward' : 'reverse';
    await this.write({ direction });
  }

  private syncModeSwitch(): void {
    this.sleepSwitch?.updateCharacteristic(
      this.platform.Characteristic.On,
      this.state.mode === MODE_SLEEP,
    );
  }

  /** Optimistic local update plus one batched write. */
  private async write(patch: Partial<FanState>): Promise<void> {
    Object.assign(this.state, patch);
    try {
      await this.transport.set(toDps(patch, this.dpsOptions));
    } catch (error) {
      this.platform.log.warn(`[${this.device.name}] write failed:`, error instanceof Error ? error.message : error);
    }
  }

  private async refresh(): Promise<void> {
    try {
      this.applyUpdate(await this.transport.get());
    } catch (error) {
      this.platform.log.debug(`[${this.device.name}] initial refresh failed:`, error instanceof Error ? error.message : error);
    }
  }

  private applyUpdate(dps: Record<string, unknown>): void {
    const patch = toFanState(dps as Record<string, string | number | boolean>, this.dpsOptions);
    if (Object.keys(patch).length === 0) {
      return;
    }
    Object.assign(this.state, patch);
    // Debug, not info — eight fans pushing state at info level floods the log.
    this.platform.log.debug(`[${this.device.name}] update:`, JSON.stringify(patch));

    const { Characteristic } = this.platform;
    if (patch.power !== undefined) {
      this.fan.updateCharacteristic(Characteristic.Active, patch.power ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
    }
    if (patch.speedStep !== undefined || patch.power !== undefined) {
      this.fan.updateCharacteristic(Characteristic.RotationSpeed, this.state.power ? stepToPercent(this.state.speedStep) : 0);
    }
    if (patch.direction !== undefined) {
      this.fan.updateCharacteristic(
        Characteristic.RotationDirection,
        patch.direction === 'forward' ? Characteristic.RotationDirection.CLOCKWISE : Characteristic.RotationDirection.COUNTER_CLOCKWISE,
      );
    }
    if (patch.mode !== undefined) {
      this.syncModeSwitch();
    }
    if (this.light && patch.lightPower !== undefined) {
      this.light.updateCharacteristic(Characteristic.On, patch.lightPower);
    }
    if (this.light && patch.lightBrightness !== undefined) {
      this.light.updateCharacteristic(Characteristic.Brightness, patch.lightBrightness);
    }
  }
}
```

- [ ] **Step 4: Run tests and delete the old file**

```bash
npx vitest run test/accessory.test.ts
git rm src/platformAccessory.ts
npm run build
```

Expected: tests PASS, build clean.

- [ ] **Step 5: Commit**

Add under `## [Unreleased]`:

```markdown
### Removed

- **BREAKING:** `SwingMode` no longer carries the fan mode. The hardware has three modes
  (nature, sleep, smart) and no manual mode, so neither `SwingMode` nor `TargetFanState` can
  represent it without losing information — selecting sleep previously read back as smart.
  **Any automation built on the fan's swing control will need rebuilding.**

### Added

- Optional Nature, Sleep and Smart switches per fan, enabled with `exposeModeSwitches`.

### Fixed

- Offline fans no longer report stale state. HomeKit now shows "No Response" when the plugin
  cannot reach a device, instead of continuing to display the last known values.
- The fan and light services no longer share a name, which caused HomeKit name warnings.
- Per-datapoint updates now log at debug level instead of info.
```

```bash
git add -A
git commit -m "feat!: correct HomeKit modelling

BREAKING: SwingMode no longer carries the fan mode. The hardware has
three modes (nature/sleep/smart) and no manual mode, so TargetFanState
cannot represent it either. Modes are now optional Switch services.

Offline fans reported stale state; onGet now surfaces No Response."
```

---

### Task #9: Build the custom settings UI

**Goal:** Scanning for fans and fetching local keys replaces hand-typing 32 fields.

**Files:**
- Create: `homebridge-ui/server.js`, `homebridge-ui/public/index.html`, `src/tuya/cloud.ts`

**Acceptance Criteria:**
- [ ] "Scan for fans" lists discovered devices with id, IP and version
- [ ] "Fetch keys from Tuya Cloud" takes Access ID, Secret and region and returns local keys
- [ ] Cloud credentials are never written to `config.json`
- [ ] The server reuses `dist/tuya/discovery.js` rather than reimplementing discovery
- [ ] Requests fail with a readable message rather than hanging

**Verify:** Open the plugin settings at `http://192.0.2.10:8581`, click Scan → all 8 fans listed; enter Tuya credentials → keys populate.

**Steps:**

- [ ] **Step 1: Implement the cloud client**

```ts
// src/tuya/cloud.ts
import crypto from 'node:crypto';

export const TUYA_REGIONS = {
  eu: 'openapi.tuyaeu.com',
  us: 'openapi.tuyaus.com',
  cn: 'openapi.tuyacn.com',
  in: 'openapi.tuyain.com',
} as const;

export type TuyaRegion = keyof typeof TUYA_REGIONS;

export interface CloudDevice {
  id: string;
  name: string;
  key: string;
  ip: string;
  online: boolean;
}

const EMPTY_BODY_HASH = crypto.createHash('sha256').update('').digest('hex');

/**
 * Tuya signs requests as HMAC-SHA256 over clientId + [token] + timestamp + nonce + stringToSign.
 * The access secret grants full account control and must never be persisted.
 */
export class TuyaCloud {
  constructor(
    private readonly clientId: string,
    private readonly secret: string,
    region: TuyaRegion,
  ) {
    this.host = TUYA_REGIONS[region];
  }

  private readonly host: string;
  private token?: string;

  private sign(payload: string): string {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('hex').toUpperCase();
  }

  private async call<T>(path: string): Promise<T> {
    const t = Date.now().toString();
    const nonce = crypto.randomUUID();
    const stringToSign = `GET\n${EMPTY_BODY_HASH}\n\n${path}`;
    const payload = this.token
      ? this.clientId + this.token + t + nonce + stringToSign
      : this.clientId + t + nonce + stringToSign;

    const res = await fetch(`https://${this.host}${path}`, {
      headers: {
        client_id: this.clientId,
        sign: this.sign(payload),
        t,
        nonce,
        sign_method: 'HMAC-SHA256',
        ...(this.token ? { access_token: this.token } : {}),
      },
    });

    const body = await res.json() as { success: boolean; msg?: string; result: T };
    if (!body.success) {
      throw new Error(body.msg ?? 'Tuya API request failed');
    }
    return body.result;
  }

  async authenticate(): Promise<void> {
    const result = await this.call<{ access_token: string }>('/v1.0/token?grant_type=1');
    this.token = result.access_token;
  }

  async getDevice(id: string): Promise<CloudDevice> {
    const d = await this.call<{ id: string; name: string; local_key: string; ip: string; online: boolean }>(`/v1.0/devices/${id}`);
    return { id: d.id, name: d.name, key: d.local_key, ip: d.ip, online: d.online };
  }
}
```

- [ ] **Step 2: Implement the UI server**

```js
// homebridge-ui/server.js
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { discover } from '../dist/tuya/discovery.js';
import { TuyaCloud } from '../dist/tuya/cloud.js';

class VentairUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest('/discover', async () => {
      try {
        return await discover(12000);
      } catch (error) {
        throw new RequestError('Discovery failed', { message: error.message });
      }
    });

    // Credentials arrive per-request and are never stored anywhere.
    this.onRequest('/keys', async ({ clientId, secret, region, ids }) => {
      if (!clientId || !secret) {
        throw new RequestError('Access ID and Secret are required');
      }
      try {
        const cloud = new TuyaCloud(clientId, secret, region ?? 'eu');
        await cloud.authenticate();
        return await Promise.all(ids.map(id => cloud.getDevice(id)));
      } catch (error) {
        throw new RequestError('Could not fetch keys', { message: error.message });
      }
    });

    this.ready();
  }
}

(() => new VentairUiServer())();
```

- [ ] **Step 3: Implement the UI page**

```html
<!-- homebridge-ui/public/index.html -->
<div class="card">
  <h5>Find your fans</h5>
  <p class="text-muted small">
    Scans the local network for Tuya devices. Your fans must be on the same network as Homebridge.
  </p>
  <button class="btn btn-primary" id="scan">Scan for fans</button>
  <div id="scan-result" class="mt-3"></div>
</div>

<div class="card mt-3">
  <h5>Fetch local keys</h5>
  <p class="text-muted small">
    Local keys come from your Tuya IoT project. These credentials are used once for this
    request and are <strong>not saved</strong> to your Homebridge config.
  </p>
  <input class="form-control mb-2" id="clientId" placeholder="Access ID">
  <input class="form-control mb-2" id="secret" type="password" placeholder="Access Secret">
  <select class="form-control mb-2" id="region">
    <option value="eu">Europe</option>
    <option value="us">Americas</option>
    <option value="cn">China</option>
    <option value="in">India</option>
  </select>
  <button class="btn btn-primary" id="fetch">Fetch keys and fill config</button>
  <div id="key-result" class="mt-3"></div>
</div>

<script>
  let discovered = [];

  document.getElementById('scan').addEventListener('click', async () => {
    const out = document.getElementById('scan-result');
    out.textContent = 'Scanning, this takes about 12 seconds...';
    try {
      discovered = await homebridge.request('/discover');
      out.innerHTML = discovered.length
        ? '<ul>' + discovered.map(d => `<li>${d.id} — ${d.ip} (v${d.version})</li>`).join('') + '</ul>'
        : 'No devices found. Check that Homebridge is on the same network as your fans.';
    } catch (e) {
      out.textContent = e.message;
    }
  });

  document.getElementById('fetch').addEventListener('click', async () => {
    const out = document.getElementById('key-result');
    if (!discovered.length) {
      out.textContent = 'Scan for fans first.';
      return;
    }
    out.textContent = 'Contacting Tuya...';
    try {
      const devices = await homebridge.request('/keys', {
        clientId: document.getElementById('clientId').value.trim(),
        secret: document.getElementById('secret').value.trim(),
        region: document.getElementById('region').value,
        ids: discovered.map(d => d.id),
      });

      const config = await homebridge.getPluginConfig();
      const platform = config[0] ?? { platform: 'HomebridgeVentairCeilingFan', name: 'Skyfan DC Ceiling Fan' };
      platform.devices = devices.map(d => ({
        name: d.name, id: d.id, key: d.key, hasLight: false, exposeModeSwitches: false,
      }));
      await homebridge.updatePluginConfig([platform]);
      await homebridge.savePluginConfig();

      // Clear the secret from the DOM as soon as it's been used.
      document.getElementById('secret').value = '';
      out.textContent = `Filled in ${devices.length} fan(s). Review the settings below and restart Homebridge.`;
    } catch (e) {
      out.textContent = e.message;
    }
  });
</script>
```

- [ ] **Step 4: Build and verify in the UI**

```bash
npm run build
npm run lint
```

Then deploy per Task #10's install steps and open the plugin settings page.

- [ ] **Step 5: Commit**

Add under `## [Unreleased]` → `### Added`:

```markdown
- Custom settings UI with a network scan and a Tuya cloud local-key fetch, so devices no
  longer need to be entered by hand.

### Security

- Tuya cloud credentials entered in the settings UI are used for a single request and are
  never written to `config.json`.
```

```bash
git add homebridge-ui src/tuya/cloud.ts CHANGELOG.md
git commit -m "feat: custom settings UI with scan and key fetch

Cloud credentials are used per-request and never persisted to config."
```

---

### Task #10: Deploy and verify on the live bridge — one fan, then eight

**Goal:** Prove the rework on real hardware, one fan before all eight.

> **USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:**
- Modify: `README.md`, `CLAUDE.md`

**Acceptance Criteria:**
- [ ] Tarball installs into the container; bridge restarts clean on Homebridge 2.2.1 / Node 24
- [ ] No ESM load error and no characteristic warnings in the log
- [ ] ONE fan verified end-to-end first: on/off, all 5 speeds, both directions
- [ ] Only after the single fan passes, all 8 registered and responding
- [ ] Discovery resolves IP with no `ip` in config
- [ ] A corrupt device entry is logged readably and skipped; siblings still work
- [ ] Unplug/replug shows "No Response" then recovers without a retry storm
- [ ] README states light support is untested and documents the breaking change
- [ ] No local key appears in any captured log output

**Verify:** `curl -s http://192.0.2.10:8581/api/status/homebridge -H "Authorization: Bearer $TOKEN"` reports up, and the plugin log shows 8 registered accessories with zero warnings.

**Steps:**

- [ ] **Step 1: Full local gate**

```bash
npm run lint && npm run test && npm run build
```

Expected: all three pass. Do not deploy otherwise.

- [ ] **Step 2: Pack and install into the container**

```bash
npm pack
TARBALL=$(ls homebridge-ventair-ceiling-fan-2.0.0.tgz)
sshpass -p "$UNRAID_PW" scp "$TARBALL" root@192.0.2.10:/tmp/
sshpass -p "$UNRAID_PW" ssh root@192.0.2.10 \
  "docker cp /tmp/$TARBALL homebridge:/tmp/ && \
   docker exec homebridge npm install --prefix /var/lib/homebridge /tmp/$TARBALL"
```

Expected: npm reports the package added.

- [ ] **Step 3: Configure ONE fan only**

Authenticate against the UI API and write a single-device config. Keys come from the environment — never inline them into a committed script.

```bash
TOKEN=$(curl -s -X POST http://192.0.2.10:8581/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$HB_USER\",\"password\":\"$HB_PASS\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

python3 - <<'EOF' > /tmp/plugin-config.json
import json, os
print(json.dumps([{
  "platform": "HomebridgeVentairCeilingFan",
  "name": "Skyfan DC Ceiling Fan",
  "devices": [{
    "name": "Family Room Fan",
    "id": "bf01000000000000000a",
    "key": os.environ["FAN_KEY"],
    "hasLight": False,
    "exposeModeSwitches": True
  }]
}]))
EOF

curl -s -X POST "http://192.0.2.10:8581/api/config-editor/plugin/homebridge-ventair-ceiling-fan" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @/tmp/plugin-config.json
```

Note `ip` is deliberately omitted — this exercises discovery.

- [ ] **Step 4: Restart and read the log**

```bash
curl -s -X PUT "http://192.0.2.10:8581/api/server/restart" -H "Authorization: Bearer $TOKEN"
sleep 25
sshpass -p "$UNRAID_PW" ssh root@192.0.2.10 'docker logs --tail 120 homebridge'
```

Expected: `Adding new ceiling fan: Family Room Fan`, a `connected` line, no `ERR_REQUIRE_ESM`, no characteristic warnings. Confirm no 16-character key string appears anywhere in the output.

- [ ] **Step 5: Exercise the single fan end-to-end**

Through the Home app (or `hb-service` HAP calls), for the Family Room fan:

| Check | Expected |
|---|---|
| Toggle Active on | Fan spins, speed shows 20% |
| Set speed to each of 20/40/60/80/100% | Physical speed changes at every step |
| Set speed to 0 | Fan stops, Active flips to off |
| Toggle direction | Blade direction reverses |
| Nature / Sleep / Smart switches | Exactly one on at a time |
| Unplug fan at the wall, wait 60s | Tile shows "No Response" |
| Replug, wait 60s | Recovers; log shows a bounded number of retries, not a storm |

Record the observed result for each row. **Do not proceed to Step 6 until every row passes.**

- [ ] **Step 6: Expand to all eight**

Repeat Step 3 with all 8 devices from the room map, then restart and confirm 8 accessories register and each responds.

- [ ] **Step 7: Verify the skip-bad-device policy**

Add a ninth entry with a deliberately short key, restart, and confirm the log warns about that device by name while the other 8 still load.

- [ ] **Step 8: Update the docs**

In `README.md`, add a Homebridge v2 requirement note, a breaking-change section for 2.0.0 covering the `SwingMode` removal, and an explicit statement that light support is untested. Update `CLAUDE.md` to reflect the new module layout, the ESM build, and the corrected DPS table.

- [ ] **Step 9: Promote the changelog to a release**

Rename `## [Unreleased]` to `## [2.0.0] - <today's date>`, add a fresh empty `## [Unreleased]`
above it, and add a short migration note at the top of the 2.0.0 section:

```markdown
## [Unreleased]

## [2.0.0] - 2026-07-28

> **Upgrading from 1.x:** this release requires Homebridge 1.8+ (2.x recommended) and
> Node 22.10+. The fan mode is no longer exposed through `SwingMode` — see Removed below.
> Rebuild any automation that used the fan's swing control.
```

Verify the changelog is complete: every task from #1 through #9 should have contributed at
least one entry. A category with no entries should be deleted rather than left empty.

- [ ] **Step 10: Commit and tag**

```bash
git add -A
git commit -m "docs: 2.0.0 release notes and updated architecture notes"
git tag -a v2.0.0 -m "Homebridge v2 support, ESM, Zod config validation"
```

```json:metadata
{"userGate": true, "tags": ["user-gate"], "requiresUserSpecification": false, "gateScope": "staged-rollout", "requireEvidenceTokens": [["one-fan", "single-fan", "Family Room"], ["all-eight", "8 fans", "eight fans"]], "verifyCommand": "npm run lint && npm run test && npm run build", "files": ["README.md", "CLAUDE.md"]}
```

---

### Task #12: Adversarial review of the completed work

**Goal:** Have Codex challenge the design decisions, not just hunt for defects, before this ships.

> **USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current
> conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline",
> or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has
> been re-validated independently, with output captured.

**Files:**
- Modify: `CHANGELOG.md` (only if the review surfaces changes worth recording)

**Acceptance Criteria:**
- [ ] `/codex:adversarial-review` run over the full branch against the baseline commit
- [ ] Codex's output returned verbatim, not paraphrased
- [ ] Every finding triaged: fixed, or explicitly declined with a stated reason
- [ ] Any resulting code change re-runs the full gate (`npm run lint && npm run test && npm run build`)
- [ ] Any behavioural change from triage is reflected in `CHANGELOG.md`

**Verify:** Review output captured in full; each finding has a recorded disposition.

**Steps:**

- [ ] **Step 1: Run the adversarial review directly**

The slash command carries `disable-model-invocation: true`, so the SlashCommand tool cannot
invoke it — but **the user explicitly authorised running the companion script directly**
(2026-07-28). Invoke the same runtime the command wraps:

```bash
node "$HOME/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs" \
  adversarial-review --background --base <baseline-commit> \
  "design assumptions, the TuyaDevice seam, reconnect backoff under 8 concurrent devices, the mode-switch modelling, and whether preserving unknown DPS mode values is the right call"
```

The baseline is the `Baseline: homebridge-ventair-ceiling-fan v1.0.4 as received` commit, so
the review sees the whole modernisation as one diff.

- [ ] **Step 1b: Second opinion via CodeRabbit**

The user also has the CodeRabbit CLI available. Run it over the same range as an independent
pass — two reviewers with different training disagree in useful ways:

```bash
coderabbit review --base <baseline-commit>
```

Reconcile the two reports: findings both raise are high-confidence; findings only one raises
still need triage, not automatic dismissal.

- [ ] **Step 2: Triage every finding**

For each item Codex raises, record one of:
- **Fixed** — with the commit that fixes it
- **Declined** — with the reason, e.g. "correct as designed: the hardware has no manual mode"

Do not silently drop findings. A finding that is wrong is still worth a one-line rebuttal,
because the next reviewer will raise it again.

Findings likely to come up, and the honest answers already established:
- *"Light support is untested"* — correct, and deliberate. No light hardware exists in this
  deployment; removing the feature would break other users of the published package.
- *"tuyapi is unmaintained"* — known and accepted; mitigated by the `TuyaDevice` seam.
- *"AES-ECB in discovery is weak"* — Tuya's wire protocol mandates it with a published
  constant key. It is not our choice, protects nothing, and is decode-only.

- [ ] **Step 3: Re-run the gate if anything changed**

```bash
npm run lint && npm run test && npm run build
```

- [ ] **Step 4: Commit any triage outcomes**

```bash
git add -A
git commit -m "fix: address adversarial review findings"
```

```json:metadata
{"userGate": true, "tags": ["user-gate"], "requiresUserSpecification": false, "gateScope": "adversarial-review", "verifyCommand": "npm run lint && npm run test && npm run build", "files": ["CHANGELOG.md"], "acceptanceCriteria": ["/codex:adversarial-review run over full branch", "output returned verbatim", "every finding triaged as fixed or declined with reason", "full gate re-run after any change", "CHANGELOG updated for behavioural changes"]}
```

---

## Self-review

**Spec coverage:** ESM/v2 migration → #1. Zod validation and skip-bad-device → #4. `dps.ts` single source → #3. TuyaDevice seam and reconnect → #5. Discovery → #6. Platform lifecycle and stale cleanup → #7. HomeKit modelling, mode switches, No Response, logging levels → #8. Custom UI and non-persisted credentials → #9. Staged deploy and verification, README caveats → #10. Numeric DP confirmation → #11. Adversarial review → #12. CHANGELOG maintained per-task throughout. Every spec section maps to a task.

**Corrections made against the spec during planning:**
- The spec named `homebridge-plugin-ui-utils`; the real package is `@homebridge/plugin-ui-utils`.
- The spec did not identify *how* to fix the `Categories` ESM break; the plan uses `api.hap.Categories` to sidestep the CJS/ESM dual-package hazard.
- tuyapi supports batched multi-DP writes, so the plan replaces the sequential single-DP writes rather than porting them.

**Known-carried risks:** light support ships untested (no light hardware); numeric DP indices confirmed in #11 before anything depends on them.
