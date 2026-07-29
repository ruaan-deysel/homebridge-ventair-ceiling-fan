import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// `persist()` lives inside an IIFE in homebridge-ui/public/index.html with no module
// exports (it's a plain <script> tag loaded by the Homebridge UI host). To exercise the
// real shipped source rather than a re-implementation of it, pull the `persist` and
// `setBusy` function bodies out of the file by brace-matching and eval them with a
// minimal `document`/`homebridge` stub. This is what lets a revert of the fix (removing
// the `catch`) actually turn this test red.
function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) {
    throw new Error(`Could not find "${signature}" in source`);
  }
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') { depth++; }
    if (source[i] === '}') {
      depth--;
      if (depth === 0) { break; }
    }
  }
  // Running off the end leaves depth > 0, which used to yield a silently truncated
  // function body — the eval below would then fail in some baffling unrelated way.
  if (depth !== 0) {
    throw new Error(`Unbalanced braces while extracting "${signature}"`);
  }
  return source.slice(start, i + 1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '../homebridge-ui/public/index.html'), 'utf8');
const persistSrc = extractFunction(html, 'async function persist(message)');
const setBusySrc = extractFunction(html, 'function setBusy(value)');

function loadUi(homebridge: unknown, document: unknown = { querySelectorAll: () => [] }) {
  const factory = new Function(
    'homebridge',
    'document',
    'platform',
    `${setBusySrc}\n${persistSrc}\nreturn { persist, setBusy };`,
  );
  const platform = { platform: 'HomebridgeVentairCeilingFan', name: 'Test', devices: [] };
  return factory(homebridge, document, platform) as {
    persist: (message?: string) => Promise<boolean>;
    setBusy: (value: boolean) => void;
  };
}

function loadPersist(homebridge: unknown) {
  return loadUi(homebridge).persist;
}

describe('homebridge-ui setBusy()', () => {
  function loadSetBusy() {
    const button = { disabled: false };
    const { setBusy } = loadUi({}, { querySelectorAll: () => [button] });
    return { setBusy, button };
  }

  it('keeps controls disabled until the LAST overlapping operation finishes', () => {
    // As a boolean flag, the first operation to finish re-enabled every button while the
    // second was still running — so a scan finishing mid-cloud-fetch handed the user live
    // buttons for an operation still in flight.
    const { setBusy, button } = loadSetBusy();

    setBusy(true);
    setBusy(true);
    expect(button.disabled).toBe(true);

    setBusy(false);
    expect(button.disabled).toBe(true);

    setBusy(false);
    expect(button.disabled).toBe(false);
  });

  it('never drops below zero, so a stray release cannot leave everything permanently disabled', () => {
    const { setBusy, button } = loadSetBusy();

    setBusy(false);
    setBusy(false);
    expect(button.disabled).toBe(false);

    setBusy(true);
    expect(button.disabled).toBe(true);
    setBusy(false);
    expect(button.disabled).toBe(false);
  });
});

describe('homebridge-ui persist()', () => {
  it('surfaces an error toast, reports failure to the caller, and does not show success when saving rejects', async () => {
    // This test used to assert `resolves.toBeUndefined()` on a rejected save — i.e. it
    // encoded the bug (a rejected save silently becoming a resolved, indistinguishable-
    // from-success persist() call) as the expected behaviour. persist() must instead give
    // its caller an explicit, checkable failure signal.
    const homebridge = {
      getPluginConfig: vi.fn().mockRejectedValue(new Error('IPC channel closed')),
      updatePluginConfig: vi.fn(),
      savePluginConfig: vi.fn(),
      toast: { success: vi.fn(), error: vi.fn() },
    };
    const persist = loadPersist(homebridge);

    await expect(persist('Saved')).resolves.toBe(false);

    expect(homebridge.toast.error).toHaveBeenCalledWith('IPC channel closed', 'Save failed');
    expect(homebridge.toast.success).not.toHaveBeenCalled();
  });

  it('shows success and no error, and reports success to the caller, when saving succeeds', async () => {
    const homebridge = {
      getPluginConfig: vi.fn().mockResolvedValue([{ platform: 'x' }]),
      updatePluginConfig: vi.fn().mockResolvedValue(undefined),
      savePluginConfig: vi.fn().mockResolvedValue(undefined),
      toast: { success: vi.fn(), error: vi.fn() },
    };
    const persist = loadPersist(homebridge);

    await expect(persist('Saved')).resolves.toBe(true);

    expect(homebridge.toast.success).toHaveBeenCalledWith('Saved');
    expect(homebridge.toast.error).not.toHaveBeenCalled();
  });

  it('re-syncs to the last actually-saved config on a rejected save, so a caller that reloads does not keep showing the unsaved mutation', async () => {
    const savedConfig = [{ platform: 'x', name: 'Real Saved Name', devices: [] }];
    const homebridge = {
      getPluginConfig: vi.fn()
        .mockResolvedValueOnce(savedConfig) // initial read inside the first persist() attempt
        .mockResolvedValue(savedConfig), // the reload after the failed save, below
      updatePluginConfig: vi.fn().mockResolvedValue(undefined),
      savePluginConfig: vi.fn().mockRejectedValue(new Error('disk full')),
      toast: { success: vi.fn(), error: vi.fn() },
    };
    const persist = loadPersist(homebridge);

    const ok = await persist('Saved');

    expect(ok).toBe(false);
    // getPluginConfig() was called a second time to reload the real, on-disk config
    // after the save failed — proof the caller's optimistic in-memory mutation gets
    // discarded rather than rendered as if it had been saved.
    expect(homebridge.getPluginConfig).toHaveBeenCalledTimes(2);
  });
});

describe('homebridge-ui badgeFor()', () => {
  const badgeForSrc = extractFunction(html, 'function badgeFor(device)');

  /** `badgeFor` builds a node via `el()`; a stub is enough to read back class + text. */
  function loadBadgeFor(lastScanIds: Set<string> | null) {
    const el = (_tag: string, attrs: Record<string, string>, text: string) => ({ ...attrs, text });
    const factory = new Function('el', 'lastScanIds', `${badgeForSrc}\nreturn badgeFor;`);
    return factory(el, lastScanIds) as (d: { id: string }) => { class: string; text: string };
  }

  it('shows "Configured" before any scan has run', () => {
    expect(loadBadgeFor(null)({ id: 'bf0000000000000000000a' }).text).toBe('Configured');
  });

  it('warns only when a scan that DID see other fans missed this one', () => {
    const badge = loadBadgeFor(new Set(['bf0000000000000000000b']));
    expect(badge({ id: 'bf0000000000000000000a' }).text).toBe('Not found on network');
  });

  it('keeps an earlier scan\'s warning when a later scan finds nothing', async () => {
    // Regression, driven through the SHIPPED scan(): a zero-result scan used to overwrite
    // the last scan with an empty set, so a fan legitimately reported missing by a scan
    // that DID see other fans silently turned green on the next empty scan.
    const scanSrc = extractFunction(html, 'async function scan()');
    const status = { textContent: '' };
    const homebridge = {
      request: vi.fn()
        .mockResolvedValueOnce([{ id: 'bf0000000000000000000b', ip: '192.0.2.11', version: '3.3' }])
        .mockResolvedValueOnce([]),
      showSpinner: () => {}, hideSpinner: () => {},
      toast: { success: () => {}, error: () => {} },
    };
    const factory = new Function('homebridge', 'document', 'setBusy', 'renderAll', 'discovered', `
      let busy = false; let lastScanIds = null;
      ${scanSrc}
      return { scan, ids: () => lastScanIds, status: () => document.getElementById('scan-status').textContent };
    `);
    const ui = factory(homebridge, { getElementById: () => status }, () => {}, () => {}, new Map()) as {
      scan: () => Promise<void>; ids: () => Set<string> | null; status: () => string;
    };

    await ui.scan();                                  // scan A: saw another fan, missed ours
    const afterA = ui.ids();
    expect(afterA?.has('bf0000000000000000000b')).toBe(true);

    await ui.scan();                                  // scan B: nothing on the network
    expect(ui.ids()).toBe(afterA);                    // scan B recorded nothing at all
    expect(ui.status()).toMatch(/left unchanged/);
    // ...so our fan still carries scan A's genuine warning.
    expect(loadBadgeFor(ui.ids())({ id: 'bf0000000000000000000a' }).text).toBe('Not found on network');
  });

  it('does not warn when the scan found nothing at all', () => {
    // A scan that heard zero broadcasts is evidence the scan could not hear — not
    // evidence that every configured fan is offline. Observed on real hardware: eight
    // fans, all reachable and controllable over TCP, every one relabelled "Not found on
    // network" because UDP announcements never reached the host.
    const badge = loadBadgeFor(new Set());
    expect(badge({ id: 'bf0000000000000000000a' }).text).toBe('Configured');
  });
});
