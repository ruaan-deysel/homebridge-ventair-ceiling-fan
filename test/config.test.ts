import { describe, expect, it, vi } from 'vitest';
import { parseDevices } from '../src/config.js';

const log = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() });

// Fixtures are synthetic. Never paste a real local key into a test file.
const valid = {
  id: 'bf01000000000000000a',
  key: 'x'.repeat(16),
  name: 'Family Room Fan',
};

describe('parseDevices', () => {
  it('accepts a minimal valid device and applies defaults', () => {
    const [d] = parseDevices({ devices: [valid] }, log());
    expect(d.hasLight).toBe(false);
    expect(d.exposeModeSwitches).toBe(false);
    expect(d.version).toBe('3.3');
    expect(d.ip).toBeUndefined();
  });

  it('preserves keys containing shell metacharacters', () => {
    const key = 'a`b|c$d<e!f?g\'h';
    expect(key.length).toBe(15);
    const padded = key + 'i';
    const [d] = parseDevices({ devices: [{ ...valid, key: padded }] }, log());
    expect(d.key).toBe(padded);
  });

  it('skips one invalid device and keeps the rest', () => {
    const l = log();
    const devices = [
      valid,
      { ...valid, id: 'bf02000000000000000a', key: 'too-short' },
      { ...valid, id: 'bf03000000000000000a' },
    ];
    const parsed = parseDevices({ devices }, l);
    expect(parsed).toHaveLength(2);
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(l.warn.mock.calls[0].join(' ')).toMatch(/16 characters/);
  });

  it('returns empty and warns when devices is missing', () => {
    const l = log();
    expect(parseDevices({}, l)).toEqual([]);
    expect(l.warn).toHaveBeenCalled();
  });

  it('rejects an unsupported protocol version', () => {
    const l = log();
    expect(parseDevices({ devices: [{ ...valid, version: '9.9' }] }, l)).toHaveLength(0);
  });

  it('never logs the key', () => {
    const l = log();
    parseDevices({ devices: [{ ...valid, name: '' }] }, l);
    const logged = JSON.stringify(l.warn.mock.calls);
    expect(logged).not.toContain(valid.key);
  });

  it('never logs the key when the key itself is the invalid field', () => {
    // The case the test above doesn't cover: an invalid NAME never put the key in
    // harm's way in the first place (zod's error only echoes the field that's wrong,
    // and the key was still valid there). Rejecting on a bad KEY is the case that
    // actually risks the key ending up in `zod.prettifyError`'s message.
    const l = log();
    const badKey = 'too-short';
    parseDevices({ devices: [{ ...valid, key: badKey }] }, l);
    const logged = JSON.stringify(l.warn.mock.calls);
    expect(logged).not.toContain(badKey);
    expect(logged).not.toContain(valid.key);
  });
});
