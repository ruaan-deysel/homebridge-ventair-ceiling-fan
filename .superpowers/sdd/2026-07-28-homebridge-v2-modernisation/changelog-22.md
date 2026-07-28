# Changelog — Task 22

## Fixed

- **Rapid successive writes silently dropped the user's command.** Reproduced on real
  hardware: driving `Active=1` then `RotationSpeed` 20→40→60→80→100 with no pause left
  HomeKit and the device both agreed on 60% — the last two commands never reached the
  fan. Cause: tuyapi serialises `set()` calls through its own internal queue, and each
  datapoint write is followed by a bounded (3s) readback to confirm it landed; under a
  rapid burst, writes backed up behind whichever one was on the wire, their readbacks
  timed out, and the caller's rollback then discarded the user's actual final choice.
  `TuyapiDevice.set()` now coalesces: at most one write is in flight and at most one
  more is queued behind it. A new call arriving while one is already queued replaces it
  outright and resolves the call it replaced immediately and quietly (no error, no
  rollback noise, no unhandled rejection) — that caller's optimistic state was about to
  be overwritten by the newer patch anyway. The write that actually reaches the wire
  still gets the full readback verification; nothing about write verification or
  optimistic rollback was weakened.

## Minor

- `test/config.test.ts`: added a case exercising an invalid KEY (previously "never logs
  the key" only tested an invalid NAME, so it never actually tested logging a bad key).
- `test/tuyapi.test.ts`: the backoff test now asserts the real scheduled `setTimeout`
  delay via a spy, instead of inferring it indirectly from `nextDelayMs` read back after
  the attempt counter had already incremented (a check that can't tell a correct
  before-increment delay computation apart from a buggy after-increment one).
- `TuyaDevice.onDps()` now returns a disposer that detaches the listener. `TuyapiDevice`
  and `FakeTuyaDevice` both implement it. Nothing in the codebase replaces an
  accessory/bridge on a live transport today (discovery runs once), so no call site
  needed updating — this closes the latent gap for if/when that changes.
