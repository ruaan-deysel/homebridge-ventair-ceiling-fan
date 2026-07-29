# Task 25 report — four concurrency defects (echo suppression, write coalescing, optimistic rollback, timeout cancellation)

`.superpowers/sdd/2026-07-28-homebridge-v2-modernisation/task-25-brief.md` did not exist;
worked from the full findings supplied in the task prompt.

## 1. Echo suppression discarding authoritative changes — `src/tuya/tuyapi.ts`

**Root cause.** `forwardDps` (formerly the inline `forward` closure) unconditionally
dropped any inbound dp echo whose `echoSuppressedUntil` deadline hadn't passed. Nothing
downstream of the filter ever saw a suppressed value, whether it was a genuinely stale
echo of our own write or a real external change. Separately, a write's own confirming
readback (`verifyWrite`) was never published to `dpsListeners` at all — it only fed the
suppression map — so the *other* consumer of the same transport (Matter if HAP wrote,
HAP if Matter wrote) never learned the new state.

**Fix.**
- `suppressedEcho: Map<string, DpValue>` buffers the latest echoed value for a dp while
  it's suppressed, instead of discarding it.
- `armSettleTimer`/`resolveSettle`: a timer fires exactly when a dp's settle window
  elapses. If nothing was buffered, it's a no-op (no extra device traffic for a quiet
  dp). If something *was* buffered, it does one authoritative `get({ dps })` and
  publishes the result to every `onDps` listener — so a wall-switch/Smart-Life change
  made mid-window is delayed by at most the remainder of the window, never lost.
- On a successful `verifyWrite`, the confirmed value is now published to every listener
  immediately (`this.dpsListeners.forEach(l => l({ [dp]: value }))`), *skipped* only
  when a newer write for the same dp is already queued behind it (checked via
  `this.pendingWrite?.dps[dp]`) — that queued write's own confirmation will supersede
  this value almost immediately, and broadcasting the intermediate one first would
  flicker listeners through a value already obsolete by the time they see it. This is
  what makes HAP and Matter converge right after either one writes, without waiting on
  an echo that suppression would drop anyway.
- Any pending settle timer for a dp is cancelled synchronously at the start of a new
  write to that same dp, so a stale authoritative-recheck can never race a fresh write.
- `disconnect()`/`recycleTransport()` clear all pending settle timers.

## 2. Merged queue acknowledging datapoints before write — `src/tuya/tuyapi.ts`

**Root cause.** `pendingWrite` held a single `{ dps, resolve, reject }`. A third
incoming call unconditionally called the *previous* queued caller's `resolve()`, even
for datapoints that survived unaltered into the merge and had not reached hardware yet.

**Fix.** `pendingWrite` now holds `{ dps, waiters: Waiter[] }`, where each `Waiter`
tracks `keys: Set<string>` — the datapoints from *its own* original call still
attributed to it. `queueWrite` shrinks every existing waiter's `keys` by whatever the
new call overwrites; a waiter only resolves early once its `keys` set is *empty* (every
datapoint it asked for was genuinely superseded before ever reaching the wire).
`writeOnce` now returns `{ confirmed: Set<string>, error: unknown }` — the datapoints it
actually verified before any failure — and `settleWaiters` resolves/rejects each
surviving waiter against `confirmed`, not against whether the write as a whole
succeeded. A merged write that fails partway now rejects *every* waiter still
attributed to a datapoint that never landed, not just the newest caller.

## 3. Older write's failure rolling back a newer write's success — `src/accessory.ts`, `src/matter.ts`

**Root cause.** `write()` snapshotted `previous` per call and unconditionally
`Object.assign(this.state, previous)` on catch, regardless of whether a newer
concurrent write had already applied its own patch to the same keys.

**Fix (identical pattern in both files).** Each `write()` call gets a monotonic
`version` and stamps `keyVersion[key] = version` for every key it touches.
`reconcileAfterFailure` computes `ownedKeys` = keys where `keyVersion[key] === version`
(i.e. nothing newer has touched them since) and only acts on those — if a newer write
already owns a key, this write's failure is a no-op for it. For keys it still owns, it
prefers an authoritative `transport.get()` over the pre-write snapshot, falling back to
the snapshot only if that read also fails (device offline, when a guess is least
trustworthy but also the only option). `CeilingFanAccessory` additionally refactored the
characteristic-push logic out of `applyUpdate` into `pushToCharacteristics(patch)` so
reconciliation can push exactly the reconciled keys to HAP.

## 4. Timeout not cancelling the underlying readback — `src/tuya/tuyapi.ts`

**Root cause investigation.** Read `node_modules/tuyapi/index.js`: `get()`/`_send()`
stores `this._resolvers[sequenceNo] = data => resolve(data)` and only ever `delete`s it
when a reply for that sequence number arrives (`onData`, ~line 836-924). `disconnect()`
does **not** clear `_resolvers`. There is no public cancel API. Our `withTimeout`
wrapper only rejected its own promise; the real `get()` promise (and its resolver
entry) lived on inside the same long-lived `TuyAPI` instance forever.

**Fix.** `withTimeout` now rejects with a distinguishable `ReadbackTimeoutError`.
`verifyWrite` recognizes it specifically and calls `recycleTransport()`: tears down the
current `TuyAPI` instance (`disconnect()` + `removeAllListeners()`), constructs and
wires a fresh one (`createDevice()`/`wireDevice()`, both extracted so construction-time
and recreation-time wiring share one path), flips `connectedState` false, notifies
`disconnectedListeners`, and feeds into the existing reconnect-supervision path
(`scheduleReconnect`). The old instance — and its stuck resolver — is simply discarded
rather than reused, so repeated timeouts across 8 fans don't grow bookkeeping.
`this.device` had to become non-`readonly` to support this.

## Tests added / changed

All in addition to the existing 112 (now 118 total):

- `test/tuyapi.test.ts`:
  - *"publishes a confirmed write to every listener immediately, so HAP and Matter
    converge..."* — two independent `onDps` subscribers on one transport; only one
    calls `set()`; both must see the confirmed value. **Explicitly requested
    (HomeKit-to-Matter sync).**
  - *"reconciles an external change that arrived during the suppression window with an
    authoritative read, instead of losing it"* — a differing echo arrives mid-window,
    is held back, then a mocked authoritative `get()` reconciles it after the window.
    **Explicitly requested (external change during suppression window).**
  - *"settles every waiter for a merged write by which of its own datapoints actually
    landed, not by arrival order"* — a speed change queued behind an in-flight write,
    then merged with an unrelated direction change; the merged write fails on its first
    datapoint; both queued callers must reject. **Explicitly requested
    (failure-ordering for merged writes).**
  - *"keeps outstanding transport requests bounded across repeated readback timeouts"*
    — asserts a fresh `TuyAPI` constructor call (and `disconnect()`/disconnected-listener
    notification) per timeout, 1:1, across 3 repeats. **Explicitly requested (pending
    transport requests stay bounded).**
  - *"resumes accepting echoes..."* (pre-existing) — adjusted: now asserts the immediate
    confirmed-write broadcast, then asserts a *quiet* window (no buffered activity)
    resumes with no extra device read. Behavior change is intentional per fix #1; the
    rest of its intent (echoes resume after the window) is preserved.
- `test/accessory.test.ts`: *"an older write failing after a newer write already
  succeeded does not roll back the newer state"* — older `set()` call held pending via a
  controllable promise, newer call completes first, older then rejects; asserts the
  newer value survives. **Explicitly requested (older-write rollback losing to newer
  success).**
- `test/matter.test.ts`: same scenario via `fanControl.percentSettingChange`, asserting
  `updateAccessoryState`'s last `fanControl` push still reflects the newer value.

## Revert-testing (per-test, as required)

`git stash push -m ... -- src/tuya/tuyapi.ts src/accessory.ts src/matter.ts` (source
only, tests kept at HEAD) then `npx vitest run`, then `git stash pop`.

Result: exactly the 7 new/modified tests failed against the pre-fix source — the other
111 pre-existing tests were unaffected by the stash (they don't exercise these paths).
Failures matched the described bugs precisely:
- HAP/Matter convergence test: both listener arrays empty (no broadcast).
- External-change-during-window test: buffered value never delivered, array empty.
- Merged-write failure-ordering test: promise resolved instead of rejecting (old
  "resolve the queued caller immediately" behavior) — actually surfaced as a stale-value
  readback mismatch, confirming the pre-fix merge/resolve-early path.
- Bounded-transport test: `d.connected` stayed `true` after a timeout (no recycle).
- Both older-write-loses-to-newer-success tests: state showed `0`/off (the older write's
  blind snapshot restore) instead of the newer `60`/on.
- `resumes accepting echoes...`: no immediate broadcast, array empty instead of `[{'3':5}]`.

All restored via `git stash pop`; full suite re-verified green (118/118), lint clean,
build clean — see Verify output below.

## Verify

```
$ npx vitest run
 Test Files  10 passed (10)
      Tests  118 passed (118)
   Duration  807ms

$ npm run lint
> homebridge-ventair-ceiling-fan@2.0.0 lint
> eslint . --max-warnings=0
(clean, no output)

$ npm run build
> homebridge-ventair-ceiling-fan@2.0.0 build
> rimraf ./dist && tsc
(clean, no output)
```

## Protections not weakened

- Write verification (`verifyWrite`'s readback + mismatch rejection) untouched.
- Optimistic rollback still happens — now version-gated instead of removed.
- Echo suppression still holds back stale echoes during the settle window — now
  reconciled afterward instead of dropped.
- Write coalescing (last-write-wins merge, one write in flight + one queued) untouched
  in mechanism; only the *settlement* of queued callers changed to be per-datapoint
  accurate instead of "resolve the previous queued caller unconditionally."

## Files touched

- `src/tuya/tuyapi.ts`
- `src/accessory.ts`
- `src/matter.ts`
- `test/tuyapi.test.ts`
- `test/accessory.test.ts`
- `test/matter.test.ts`
- `.superpowers/sdd/2026-07-28-homebridge-v2-modernisation/changelog-25.md` (appended,
  did not touch `CHANGELOG.md`)
