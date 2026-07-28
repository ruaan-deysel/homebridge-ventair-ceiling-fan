# Task 21 — closing out "do not ship": four incomplete signal paths, one new defect

Theme across all of these: the error HANDLER was already correct in prior rounds: rollback,
rethrow, toast, log. What was missing in each case was the SIGNAL ever reaching that
handler in a form it could act on. This round fixes the signal, not the handler.

## 1. [HIGH] `src/platform.ts` — transient Matter setup failure treated as config removal

`discoveredMatterUUIDs` used to get a device's Matter UUID pushed onto it only AFTER
`registerMatter()` succeeded. A device that is still configured with `exposeMatter: true`
but whose setup rejects this run (bridge not ready yet, a one-off startup race, ...) never
made it into that list — so `removeStaleMatterAccessories()` saw its cached UUID as "not
discovered this run" and permanently unregistered it, destroying the user's cached Matter
endpoint state over what was often a one-off error.

**Fix:** the desired-Matter-UUID set is now computed once, at the top of
`discoverDevices()`, directly from `this.devices` (already-validated config) filtered on
`exposeMatter` — before any setup is attempted. `removeStaleMatterAccessories()` takes this
set as a parameter instead of reading an instance field that was only populated on success.
A transient failure now only logs (existing per-device containment) and leaves the cached
accessory alone; a UUID is only ever classified stale if it's genuinely absent from valid
config or no longer opted into Matter.

## 2. [HIGH] `src/tuya/tuyapi.ts` — rollback signal still couldn't fire for real send failures

The connection guard added last round only checked `connectedState` once, before the loop.
Two gaps remained, both verified against `node_modules/tuyapi/index.js` (~408-441):
`set()` with `shouldWaitForResponse: false` always resolves synchronously and only
*conditionally* rejects from a `_send().catch()` gated on `shouldWaitForResponse` — so
neither a disconnect happening *between* two sequential per-datapoint writes, nor a send
failure on the wire itself, was ever caught.

**Fix — verifiable completion, not just a one-time guard:**
- The connectivity guard now runs on every datapoint iteration, not just once before the
  loop — a disconnect between datapoints now aborts the remaining patch instead of
  continuing to send into a dead socket.
- After each `set()`, a bounded readback (`get({ dps })`, wrapped in a 3s `withTimeout`,
  **never** `refresh()` — confirmed to hang 20s on this firmware) confirms the device
  actually applied the value. A timeout, a `get()` rejection, or a value mismatch (device
  silently ignored the write) all now reject the whole `set()` call instead of resolving.

**Latency tradeoff:** every successful write now costs one extra round trip (the confirming
read) on top of the original send, across up to 8 fans sharing one process — roughly double
the per-write latency on the happy path. `READBACK_TIMEOUT_MS = 3_000` bounds the failure
case tightly so a device that goes dark mid-write fails fast rather than hanging. Chosen
over `shouldWaitForResponse: true` (rejected again, same reason as the prior round: "A set
command is already in progress" on overlapping waiting sets) and over batching multiple
readbacks (this firmware ignores batched `set()`, unverified whether batched `get()` works
any differently, not worth the risk).

## 3. [HIGH] `src/matter.ts` — Matter commands reported success before the write finished

`MatterFanCallbacks.setPower`/`setPercent` were declared `void`-returning and their
callers used `void this.write(...)` — fire-and-forget. Verified against
`node_modules/homebridge/dist/matter/behaviors/OnOffBehavior.js`: `HomebridgeOnOffServer.on()`
does `await registry.executeHandler(endpointId, 'onOff', 'on')` and only calls `super.on()`
(which commits cluster state) if that resolves. A handler returning `undefined`
synchronously made that await resolve instantly regardless of the underlying write's
outcome — an offline command got a Matter success response and Homebridge committed state
the fan never received. `write()` also swallowed the error after rollback instead of
rethrowing, so even an awaited handler would have reported success.

**Fix:** `MatterFanCallbacks` now returns `Promise<void>`; every `handlers.onOff`/
`handlers.fanControl` entry in `buildMatterAccessory()` returns that promise instead of
firing-and-forgetting it; `MatterFanBridge.write()` still rolls back state and pushes it to
Matter on failure, but now rethrows afterward so the failure propagates all the way back to
Homebridge's behavior layer.

## 4. [MEDIUM] `homebridge-ui/public/index.html` — `persist()` swallowed save failure

`persist()` showed an error toast on a rejected save but still resolved normally — every
caller that had already mutated `platform`/`device` in place went on to report success and
render the never-actually-saved optimistic state.

**Fix:** `persist()` now returns `true`/`false`. On failure it also reloads the
last-actually-saved config from `homebridge.getPluginConfig()` and re-syncs `platform` to
it, so a caller that re-renders after a failed persist shows what's really on disk, not the
discarded optimistic mutation. Every caller that only ever called `persist()` (no message,
no existing `renderAll()`) now checks the return value and calls `renderAll()` on failure;
callers that already unconditionally called `renderAll()` after `persist()` (remove/add/key
save) needed no change — the reload inside `persist()` makes that call correct either way.
`fetchKeysFor()` no longer reports "Updated N key(s)" unless the save actually succeeded.

The existing regression test asserted `resolves.toBeUndefined()` on a rejected save — i.e.
it encoded the bug as expected behaviour. Rewritten to assert `resolves.toBe(false)`, plus a
new test asserting the reload-on-failure behavior.

## 5. [MAJOR] `src/tuya/cloud.ts` — `preferIPv4` lookup had no dual-stack retry

The single `lookup` sorted addresses and returned only the top pick — if that address
resolved fine but refused the TCP CONNECT (routing black hole, broken IPv4 path on an
otherwise fine dual-stack host), there was no way back to the other family.

**Fix:** split into two agents, `AGENT` (prefers IPv4, falls back to IPv6 on an IPv6-only
host — the existing behavior) and `FALLBACK_AGENT` (prefers IPv6). `call()` tries `AGENT`
first; on any request-level failure it retries once through `FALLBACK_AGENT` before mapping
the error. Preserves the IPv4-first preference and the IPv6-only fallback on the normal
path; adds exactly one retry on the alternate family after a genuine connection failure.

## 6-9. Minor

- `README.md` / `package.json`: `engines.node` and the README requirements table now read
  `^22.12.0 || ^24.0.0`. Reworded the ESM note to say this package chose to be ESM-only,
  not that Homebridge itself requires it.
- `homebridge-ui/server.js`: pulled `/keys` payload validation into an exported
  `validateKeysRequest()` (testable without booting the IPC-bound server) — throws
  `RequestError` if `clientId`/`secret` aren't non-empty strings or `ids` isn't a non-empty
  array of strings, called before `TuyaCloud` is ever constructed.
- `homebridge-ui/server.js`: the `.message` fallback changed from `??` to `||` — an
  empty-string `.message` (e.g. a bare `new Error()`) is not nullish, so `??` let it straight
  through and rendered a blank UI error.
- `test/server.test.ts`: rewritten to assert `failed[0].message === 'Unknown error'`
  (pinning the real fallback value) instead of only `typeof failed[0].message === 'string'`,
  which an empty string also satisfies.

## Tests added (every one revert-tested: reverted the fix, confirmed the new test failed,
restored the fix, confirmed it passed again)

- `test/platform.test.ts` — `'preserves a cached Matter accessory when its setup fails this
  run...'`: fails `matter.registerPlatformAccessories` once for a device with an
  already-cached Matter accessory, asserts `unregisterPlatformAccessories` is never called.
- `test/tuyapi.test.ts` — three new tests: a disconnect firing from *inside* the first
  `set()` call (between datapoints), a rejected confirming `get()`, and a `get()` that
  reports a different value than what was written.
- `test/matter.test.ts` — `'propagates a disconnected-transport write failure through the
  real Homebridge registry.executeHandler path'`: imports the actual
  `homebridge/dist/matter/behaviors/BehaviorRegistry.js` (via a relative file path, bypassing
  the package's restrictive `exports` map) and calls `registry.executeHandler(...)` — the
  exact mechanism `HomebridgeOnOffServer.on()` awaits — against a handler backed by a
  transport whose `set()` is mocked to reject. Not a mock that resolves regardless: this is
  Homebridge's real registry class making the real await/reject decision.
- `test/ui-persist.test.ts` — rewrote the bug-encoding test to assert `resolves.toBe(false)`;
  added a test asserting the config reload after a failed save.
- `test/cloud.test.ts` — two new tests: a first-attempt CONNECT failure followed by a
  successful retry through a *different* `https.Agent` instance, and both attempts failing
  producing a readable combined error. Updated two existing error-mapping tests to queue two
  failures (since a failure now retries once).
- `test/server.test.ts` — new `validateKeysRequest()` describe block covering
  missing/empty/non-string `clientId`/`secret` and malformed `ids`.

## Verify

```
$ npx vitest run
 Test Files  10 passed (10)
      Tests  103 passed (103)

$ npm run lint
> eslint . --max-warnings=0
(no output, exit 0)

$ npm run build
> rimraf ./dist && tsc
(no output, exit 0)
```

## Files touched

- `src/platform.ts`, `src/tuya/tuyapi.ts`, `src/matter.ts`, `src/tuya/cloud.ts`
- `homebridge-ui/public/index.html`, `homebridge-ui/server.js`
- `README.md`, `package.json`
- `test/platform.test.ts`, `test/tuyapi.test.ts`, `test/matter.test.ts`,
  `test/ui-persist.test.ts`, `test/cloud.test.ts`, `test/server.test.ts`
