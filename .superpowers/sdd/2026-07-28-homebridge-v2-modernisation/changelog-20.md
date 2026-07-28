# Task 20 — two ineffective-in-practice fixes from adversarial review

## 1. `src/tuya/tuyapi.ts` `set()` could never reject — rollback dead code

Verified against `node_modules/tuyapi/index.js`: with `shouldWaitForResponse: false`
(every write in this plugin), tuyapi's `set()` resolves unconditionally — a failed
`_send()` is caught internally but only rejects the caller when `shouldWaitForResponse`
was true. So `TuyapiDevice.set()` always resolved, even against a disconnected device,
which meant the optimistic-state rollback and `HapStatusError` propagation already
present in both `src/accessory.ts` `write()` and `src/matter.ts` `write()` were
unreachable — a dropped write left HomeKit/Matter showing a state the hardware never
reached.

**Fix chosen: guard on connection state.** `set()` now throws immediately if
`this.connectedState` is false, before calling `this.device.set()`. This restores the
rejection path for the dominant real failure (device offline / socket dropped) without
touching tuyapi's send path.

Rejected alternatives, per the brief:
- Flipping to `shouldWaitForResponse: true` — changes latency across 8 devices in
  production and tuyapi throws "A set command is already in progress" on overlapping
  waiting sets; a bigger, riskier change than this bug needs.
- Read-back reconciliation via `get({ schema: true })` after every write — extra
  round-trip per write across 8 devices for a case the connection guard already
  catches; `refresh()` itself is confirmed to hang 20s on this firmware and was never
  considered. Left for later if silent partial-application (write reaches the device
  but doesn't take effect) turns out to be a real, separate failure mode.

No changes needed in `accessory.ts` / `matter.ts` — their `write()` catch blocks
already do the rollback + `HapStatusError` throw correctly; they were just never
exercised.

## 2. `src/tuya/cloud.ts` Happy Eyeballs workaround removed IPv4 fallback instead of preferring it

`autoSelectFamily: false` alone just defers to whatever DNS resolution order the
resolver returns first. The "200 in 806ms" success on the target bridge was that
resolver happening to return the A record first — not a general fix. On a host where
AAAA sorts first with no usable IPv6 route, the same tuya/tuya-homebridge#412 bug
reproduces.

**Fix:** added a module-scoped custom `lookup` (`preferIPv4`) on the existing
`https.Agent`. It resolves all addresses via `dns.lookup(hostname, { all: true })`,
sorts IPv4 (`family: 4`) ahead of IPv6, and returns only the top pick — so an IPv4
address is used whenever one exists, and an IPv6-only host (no A record at all) still
gets its AAAA address, since that's all that's left after sorting. No `family: 4` pin
(that was already rejected for breaking IPv6-only users) and no changes to global
`dns`/`net` state — the `lookup` is scoped to this one `https.Agent` instance. The
existing comment block referencing tuya/tuya-homebridge#412 was kept and extended
rather than replaced.

## Tests added (all revert-tested: reverted the fix, confirmed the new test failed,
restored the fix, confirmed it passed again)

- `test/tuyapi.test.ts` — `'rejects a write attempted while disconnected instead of
  silently swallowing it'`: asserts `d.set(...)` rejects with a message matching
  `/disconnected/i` and that the underlying `device.set` mock was never called.
  Reverting the `connectedState` guard makes the promise resolve instead of reject —
  confirmed failing, then confirmed passing again after restoring the guard.
- `test/cloud.test.ts` — two new tests under `'custom DNS lookup
  (tuya/tuya-homebridge#412)'`, both pulling the *real* `lookup` function off the
  captured `https.Agent` constructor args (not a reimplementation) and driving it
  against a mocked `node:dns`:
  - AAAA-first with a usable A record present → asserts the IPv4 address/family is
    chosen.
  - IPv6-only (no A record) → asserts the IPv6 address/family is still returned.
  Reverting to the old `new https.Agent({ autoSelectFamily: false, keepAlive: true })`
  (no `lookup`) makes both fail with `lookupFn(...) is not a function` — confirmed
  failing, then confirmed passing again after restoring `lookup: preferIPv4`.

## Verify

```
$ npx vitest run
 Test Files  10 passed (10)
      Tests  90 passed (90)

$ npm run lint
> eslint . --max-warnings=0
(no output, exit 0)

$ npm run build
> rimraf ./dist && tsc
(no output, exit 0)
```

## Files touched

- `src/tuya/tuyapi.ts`
- `src/tuya/cloud.ts`
- `test/tuyapi.test.ts`
- `test/cloud.test.ts`
