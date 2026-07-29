### Changed
- Redesigned the plugin settings page. Fans now read as a single grouped list rather than
  eight stacked cards, and a fan whose key is already stored shows a quiet confirmation
  instead of an empty input and two filled buttons. Advanced settings (pinned IP) are folded
  away, device IDs are truncated with the full value on hover, and the toggles are switches.

### Fixed — concurrency: echo suppression, write coalescing, optimistic rollback, timeout cancellation

Four "do not ship" concurrency defects, all rooted in the same tension: optimistic
local state, the write queue, echo suppression, and two independent consumers (HomeKit
and Matter) racing each other.

1. **Echo suppression no longer discards authoritative state changes**
   (`src/tuya/tuyapi.ts`). A datapoint echo arriving while its write is suppressed is
   now buffered (`suppressedEcho`), not dropped. Once the settle window naturally
   elapses (`armSettleTimer`/`resolveSettle`), if anything was buffered, an
   authoritative `get()` reconciles the datapoint and publishes the result to every
   listener — a wall-switch/Smart-Life change made during the ~1.5s settle window now
   always reaches HomeKit, delayed by at most the remainder of the window, never lost.
   Every confirmed write is also now published to all `onDps` listeners immediately
   after its readback verifies (skipped only when a newer queued write for the same
   datapoint would immediately supersede it), which is what lets HAP and Matter
   converge on the same state right after either one writes.

2. **Merged write queue no longer resolves a caller before its datapoints are
   written** (`src/tuya/tuyapi.ts`). `pendingWrite` now tracks a list of waiters, each
   retaining the set of datapoint keys still attributed to it. A later merged call only
   supersedes (and immediately resolves) the keys it actually overwrites; a key that
   survives unaltered into the merge keeps its original caller waiting until `writeOnce`
   reports it genuinely confirmed. A failed merged write now rejects every waiter still
   attributed to the datapoints that never landed, not just the newest one.

3. **An older write's failure no longer rolls back a newer write's success**
   (`src/accessory.ts`, `src/matter.ts`). Both `write()` implementations now version
   each datapoint they touch and only roll back keys the failed write still "owns"
   (nothing newer has touched them since), preferring an authoritative device read over
   the pre-write snapshot when reconciling.

4. **Timed-out readbacks no longer leak the underlying transport request**
   (`src/tuya/tuyapi.ts`). Installed tuyapi (7.7.1) stores a resolver per outgoing
   sequence number that is never cleared on our own timeout and exposes no
   cancellation API. A readback timeout now tears down the whole `TuyAPI` instance and
   swaps in a fresh one (`recycleTransport`), discarding the stuck resolver instead of
   letting it accumulate across repeated timeouts.

Six new regression tests, plus one pre-existing test adjusted, across
`test/tuyapi.test.ts`, `test/accessory.test.ts` and `test/matter.test.ts`; every
new/modified test was revert-tested against the pre-fix code and confirmed to fail there
before being restored.
