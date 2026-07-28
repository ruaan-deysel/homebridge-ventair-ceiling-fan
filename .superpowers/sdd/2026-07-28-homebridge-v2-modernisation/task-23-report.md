# Task 23 Report — Receive-side echo race fix

## Bug recap

Task 22 fixed send-side coalescing in `TuyapiDevice.set()` (last write wins going out).
That was correct but insufficient: `applyUpdate()` in both `CeilingFanAccessory` and
`MatterFanBridge` applies every inbound device push unconditionally. The fan echoes its
state as it works through queued commands, and a stale echo (carrying an OLDER value)
can land *after* our own newer write's readback has already confirmed success —
overwriting the correct optimistic state with a stale one. HomeKit then shows the last
echo, not the last command. Confirmed live: dragging RotationSpeed 20→40→60→80→100 left
HomeKit and the device both at 60%/step 3.

## Fix

`src/tuya/tuyapi.ts` (`TuyapiDevice`):

- New `echoSuppressedUntil: Map<string /* dp */, number /* Date.now()-scale deadline */>`.
- `writeOnce()` sets `echoSuppressedUntil.set(dp, Infinity)` the instant a datapoint
  write goes on the wire (before `device.set()`), i.e. for the entire in-flight window,
  not just during the readback — an echo racing in between the send and the readback is
  just as stale as one during the readback.
- On a successful, verified write, the deadline becomes `Date.now() + ECHO_SETTLE_MS`
  (1.5s) — a short grace period for trailing echoes of the just-superseded intermediate
  values to also get dropped.
- On a failed write, the dp's entry is deleted entirely (outcome unknown; stop trusting
  our own state over the device's — the next echo, whatever it says, is believed).
- The `data`/`dp-refresh` forwarding closure now filters each inbound dp: anything with
  an unexpired deadline is dropped before the event ever reaches `dpsListeners`. A dp
  absent from the map (no pending write, ever) passes straight through — unmodified path
  for physical remote / Smart Life app changes.

### Placement rationale

Put in the transport, not duplicated in `accessory.ts` and `matter.ts`, because:
1. Both consumers subscribe to the exact same `TuyaDevice.onDps()` stream from the same
   transport instance — fixing at the source fixes both, once.
2. Only the transport actually knows which writes are in flight (`writeOnce`/
   `verifyWrite` already live here); the UI-facing files would need a parallel, harder-
   to-keep-correct copy of that bookkeeping to reach the same decision.
3. It does not widen the transport's existing responsibility — `TuyapiDevice` already
   owns "is a write to this dp trustworthy right now" via `verifyWrite`; extending that
   same knowledge to "is an echo of this dp trustworthy right now" is the same concern,
   not a new one.

No changes to `verifyWrite`, the readback timeout, or the accessory's optimistic
rollback — this only filters which inbound pushes get forwarded, never what a write's
own readback trusts.

## Tests added (`test/tuyapi.test.ts`)

1. **"ignores stale echoes ... applies the last COMMAND, not the last echo"** —
   reproduces the drag: three coalesced writes to dp `3` (2, 3→superseded, 5) with stale
   echoes (`1`, `2`, `3`, then `2` again post-settle-but-within-window) interleaved.
   Asserts none of the stale values ever reach a listener and the device's actual state
   is the last command (5).
   - **Revert-tested:** reverted `src/tuya/tuyapi.ts` only (kept the new tests), ran
     just this test — **FAILED**: `expected [ 1, 2, 3, 2 ] to not include 1`. Restored
     the fix, re-ran — **PASSED**.

2. **"applies an echo immediately for a datapoint with no pending write"** — dp `1` has
   never been written; an echo for it must reach the listener immediately (physical
   wall control / Smart Life app path).
   - **Revert-tested:** with the fix reverted, this test still **PASSED** — expected and
     correct, since this path is untouched by the fix (no suppression ever applies to a
     dp with no pending write, before or after the change). It is a regression guard for
     the fix's own escape hatch, not a fix-validation test; noted explicitly so it isn't
     mistaken for a vacuous assertion.

3. **"resumes accepting echoes ... once its settle window has elapsed"** — after a
   confirmed write to dp `3`, an echo immediately after is dropped; the same echo after
   1501ms (past the 1.5s `ECHO_SETTLE_MS` window) is applied.
   - **Revert-tested:** reverted `src/tuya/tuyapi.ts` only, ran just this test —
     **FAILED**: `expected [ { '3': 4 } ] to have a length of +0 but got 1` (the
     immediately-after-settle assertion, since without the fix there is no suppression
     at all). Restored the fix, re-ran — **PASSED**.

## Verify

### `npx vitest run`
```
 Test Files  10 passed (10)
      Tests  109 passed (109)
   Duration  800ms
```
(106 pre-existing + 3 new; none regressed.)

### `npm run lint`
```
> homebridge-ventair-ceiling-fan@2.0.0 lint
> eslint . --max-warnings=0
```
Clean, no output, exit 0.

### `npm run build`
```
> homebridge-ventair-ceiling-fan@2.0.0 build
> rimraf ./dist && tsc
```
Clean, no output, exit 0.

## Files touched

- `/Users/ruaandeysel/Github/homebridge-ventair-ceiling-fan/src/tuya/tuyapi.ts` — fix
- `/Users/ruaandeysel/Github/homebridge-ventair-ceiling-fan/test/tuyapi.test.ts` — 3 new tests
- `/Users/ruaandeysel/Github/homebridge-ventair-ceiling-fan/.superpowers/sdd/2026-07-28-homebridge-v2-modernisation/changelog-23.md` — changelog entry (per instructions, not `CHANGELOG.md`)
