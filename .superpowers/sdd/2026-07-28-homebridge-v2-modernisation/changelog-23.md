# Changelog — Task 23

## Fixed

- **Stale device echoes overwrote a still-settling optimistic write, losing the user's
  final choice on the RECEIVE side.** Task 22 fixed the send-side coalescing (last
  write wins on the way out), but the fan continues to echo its state as it works
  through queued commands, and an echo carrying an OLDER value could still arrive after
  our own newer, already-confirmed write and silently overwrite it. Live evidence:
  dragging RotationSpeed 20→40→60→80→100 left both HomeKit and the device at 60%/step 3
  even though the coalesced write correctly reached the fan as 100%/step 5 — the last
  echo won, not the last command.

  `TuyapiDevice` now tracks, per datapoint, a deadline until which inbound echoes are
  ignored: set to "indefinite" the moment a write to that dp goes on the wire, and to
  "now + 1.5s" once that write's readback confirms it landed. Echoes for a datapoint
  with no pending write (a physical wall control, the Smart Life app) are completely
  untouched and still apply immediately — that path was not touched.

  Placed in the transport (`src/tuya/tuyapi.ts`), inside the same `data`/`dp-refresh`
  forwarding path that already owns write-in-flight state (`writeOnce`/`verifyWrite`).
  Both `CeilingFanAccessory` and `MatterFanBridge` consume `TuyaDevice.onDps()` from the
  same transport instance, so suppressing at the source fixes both consumers at once
  instead of duplicating the same stale-vs-fresh bookkeeping in two UI-facing files that
  have no visibility into which writes are actually in flight.

  Read-side verification (`verifyWrite`) and the accessory's optimistic rollback are
  unchanged — this only filters which inbound pushes get forwarded to listeners, never
  what a write's own readback trusts.
