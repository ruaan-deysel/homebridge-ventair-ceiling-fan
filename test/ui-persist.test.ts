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
  return source.slice(start, i + 1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '../homebridge-ui/public/index.html'), 'utf8');
const persistSrc = extractFunction(html, 'async function persist(message)');
const setBusySrc = extractFunction(html, 'function setBusy(value)');

function loadPersist(homebridge: unknown) {
  const factory = new Function(
    'homebridge',
    'document',
    'platform',
    `${setBusySrc}\n${persistSrc}\nreturn persist;`,
  );
  const document = { querySelectorAll: () => [] };
  const platform = { platform: 'HomebridgeVentairCeilingFan', name: 'Test', devices: [] };
  return factory(homebridge, document, platform);
}

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
