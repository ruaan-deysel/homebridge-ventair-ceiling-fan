# Task 21 report — closing "do not ship" findings

See `.superpowers/sdd/2026-07-28-homebridge-v2-modernisation/changelog-21.md` for the
full per-finding writeup. Summary here.

## Findings addressed

1. **[HIGH] Matter stale cleanup destroyed user data.** `discoverDevices()` now computes
   the desired Matter UUID set from valid config *before* any setup is attempted, and
   `removeStaleMatterAccessories()` takes that set as a parameter instead of an
   instance field populated only on success. A transient setup failure on a
   still-configured, cached Matter fan can no longer make it look "removed from
   config" and get unregistered.

2. **[HIGH] tuyapi `set()` rollback signal still couldn't fire.** The connectivity
   guard now runs per-datapoint (not once before the loop), and every datapoint write
   is followed by a bounded (3s) readback via `get({ dps })` that confirms the value
   actually landed — never `refresh()`, confirmed to hang 20s on this firmware. A
   disconnect between datapoints, a failed/timed-out readback, or a device silently
   ignoring the write all now reject instead of resolving as success.

3. **[HIGH] Matter commands reported success before the write finished.** Both
   `MatterFanCallbacks` methods and every `handlers.onOff`/`handlers.fanControl` entry
   in `buildMatterAccessory()` now return the write's promise instead of firing and
   forgetting it, and `MatterFanBridge.write()` rethrows after rollback instead of
   swallowing the error. Verified against `HomebridgeOnOffServer.on()` in
   `node_modules/homebridge/dist/matter/behaviors/OnOffBehavior.js`, which awaits
   `registry.executeHandler(...)` before committing cluster state.

4. **[MEDIUM] `persist()` swallowed save failure.** Now returns `true`/`false` and
   reloads the last actually-saved config on failure so a caller's optimistic mutation
   is discarded instead of rendered as if saved. Every bare `await persist()` call
   site now checks the result and re-renders on failure; the bug-encoding test
   (`resolves.toBeUndefined()` on a rejected save) is rewritten to assert
   `resolves.toBe(false)`.

5. **[MAJOR] `preferIPv4` had no dual-stack retry.** Split into `AGENT` (IPv4
   preferred) and `FALLBACK_AGENT` (IPv6 preferred); `call()` retries once through
   `FALLBACK_AGENT` on any connection-level failure of the first attempt.

6-9. **Minor.** README/package.json Node range → `^22.12.0 || ^24.0.0`, ESM note
   reworded to be about this package only. `homebridge-ui/server.js` `/keys` now
   validates `clientId`/`secret`/`ids` via an exported `validateKeysRequest()` before
   constructing `TuyaCloud`. Empty/missing `.message` fallback changed `??` → `||`
   (empty string isn't nullish). `test/server.test.ts` now pins
   `failed[0].message === 'Unknown error'`.

## Approach for #2 (write verifiability) and its latency tradeoff

Chose a bounded confirming readback over the two alternatives considered and rejected:
`shouldWaitForResponse: true` (reintroduces "A set command is already in progress" on
overlapping waiting sets — ruled out in the prior round for the same reason) and a
batched multi-dp readback (this firmware silently ignores batched `set()`; unverified
whether a batched `get()` behaves any better, not worth the risk). The guard now
re-checks connectivity before *every* datapoint (not just once), and after each `set()`
issues `get({ dps })` wrapped in a 3-second timeout, rejecting on timeout, on a `get()`
failure, or on a value mismatch.

**Tradeoff:** every successful write now costs one extra round trip — a confirming read
on top of the original send — across up to 8 fans sharing one Homebridge process, so
per-write latency roughly doubles on the happy path. The 3-second bound exists
specifically so a device that goes dark mid-write fails fast instead of hanging (the
same failure mode `refresh()` has at 20s, which is why `refresh()` is never used here).
This is the right tradeoff for a plugin whose primary failure mode reported by users is
silent divergence between HomeKit/Matter and hardware state, not raw latency.

## Verification

```
$ npx vitest run
 Test Files  10 passed (10)
      Tests  103 passed (103)

$ npm run lint
> eslint . --max-warnings=0
(exit 0, no output)

$ npm run build
> rimraf ./dist && tsc
(exit 0, no output)
```

## Revert-testing

Every new/rewritten test was individually revert-tested: the corresponding source file
was replaced with its pre-fix (`git show HEAD:<file>`) version, the affected test file
run in isolation to confirm the new test(s) failed, then the fixed source restored and
the suite re-run to confirm passing again. Confirmed for:

- `src/platform.ts` — new test failed (unregister called) against old code, passed
  after restore.
- `src/tuya/tuyapi.ts` — all 3 new tests failed ("promise resolved undefined instead of
  rejecting") against old code, passed after restore.
- `src/matter.ts` — the real-registry test failed ("promise resolved true instead of
  rejecting") against old code, passed after restore. (Two other tests in the same file
  also "failed" against old code because their assertions were updated for the new
  async contract — expected, not a false positive.)
- `homebridge-ui/public/index.html` — all 3 `persist()` tests failed against old code,
  passed after restore.
- `src/tuya/cloud.ts` — both new retry tests failed against old code, passed after
  restore.
- `homebridge-ui/server.js` — all `validateKeysRequest()` tests failed (function didn't
  exist yet) against old code, passed after restore.

## Files touched

`src/platform.ts`, `src/tuya/tuyapi.ts`, `src/matter.ts`, `src/tuya/cloud.ts`,
`homebridge-ui/public/index.html`, `homebridge-ui/server.js`, `README.md`,
`package.json`, `test/platform.test.ts`, `test/tuyapi.test.ts`, `test/matter.test.ts`,
`test/ui-persist.test.ts`, `test/cloud.test.ts`, `test/server.test.ts`.
