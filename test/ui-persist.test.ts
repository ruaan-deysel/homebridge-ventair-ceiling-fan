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
  it('surfaces an error toast and does not show success when saving rejects', async () => {
    const homebridge = {
      getPluginConfig: vi.fn().mockRejectedValue(new Error('IPC channel closed')),
      updatePluginConfig: vi.fn(),
      savePluginConfig: vi.fn(),
      toast: { success: vi.fn(), error: vi.fn() },
    };
    const persist = loadPersist(homebridge);

    await expect(persist('Saved')).resolves.toBeUndefined();

    expect(homebridge.toast.error).toHaveBeenCalledWith('IPC channel closed', 'Save failed');
    expect(homebridge.toast.success).not.toHaveBeenCalled();
  });

  it('shows success and no error when saving succeeds', async () => {
    const homebridge = {
      getPluginConfig: vi.fn().mockResolvedValue([{ platform: 'x' }]),
      updatePluginConfig: vi.fn().mockResolvedValue(undefined),
      savePluginConfig: vi.fn().mockResolvedValue(undefined),
      toast: { success: vi.fn(), error: vi.fn() },
    };
    const persist = loadPersist(homebridge);

    await persist('Saved');

    expect(homebridge.toast.success).toHaveBeenCalledWith('Saved');
    expect(homebridge.toast.error).not.toHaveBeenCalled();
  });
});
