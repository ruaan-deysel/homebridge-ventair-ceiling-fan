import { describe, expect, it } from 'vitest';
import { RequestError } from '@homebridge/plugin-ui-utils';
import { fetchKeys, validateKeysRequest } from '../homebridge-ui/server.js';

function fakeCloud(byId: Record<string, unknown>) {
  return {
    async getDevice(id: string) {
      const entry = byId[id];
      if (entry instanceof Error) {
        throw entry;
      }
      return entry;
    },
  };
}

describe('/keys fetchKeys()', () => {
  it('returns keys for devices that succeeded even when another device fails', async () => {
    const cloud = fakeCloud({
      good1: { id: 'good1', key: 'k1' },
      bad: new Error('Tuya API error: device not found'),
      good2: { id: 'good2', key: 'k2' },
    });

    const { devices, failed } = await fetchKeys(cloud, ['good1', 'bad', 'good2']);

    expect(devices).toEqual([{ id: 'good1', key: 'k1' }, { id: 'good2', key: 'k2' }]);
    expect(failed).toEqual([{ id: 'bad', message: 'Tuya API error: device not found' }]);
  });

  it('never lets a raw error object without .message leak an unhelpful blank value', async () => {
    // `.message` is `''` here — not null/undefined — so a `??` fallback (which only
    // triggers on nullish values) lets it straight through and renders a blank error
    // in the UI. Only `typeof failed[0].message === 'string'` was asserted before,
    // which an empty string also satisfies — this rewrite pins the actual, non-blank
    // fallback value so a regression to `??` fails this test.
    const cloud = fakeCloud({ id1: Object.assign(new Error(), { message: '' }) });
    const { failed } = await fetchKeys(cloud, ['id1']);
    expect(failed[0].id).toBe('id1');
    expect(failed[0].message).toBe('Unknown error');
  });
});

describe('/keys validateKeysRequest()', () => {
  // A malformed payload must never reach TuyaCloud (which starts signing/authenticating
  // requests) at all — every case below must throw before any network call is possible.
  it('accepts a well-formed payload', () => {
    expect(() => validateKeysRequest({ clientId: 'id', secret: 'sec', ids: ['a'] })).not.toThrow();
  });

  it('rejects a null or missing body with a RequestError instead of throwing a TypeError on destructure', () => {
    expect(() => validateKeysRequest(null)).toThrow(RequestError);
    expect(() => validateKeysRequest(undefined)).toThrow(RequestError);
    expect(() => validateKeysRequest('not an object')).toThrow(RequestError);
  });

  it('rejects a missing/empty clientId', () => {
    expect(() => validateKeysRequest({ clientId: '', secret: 'sec', ids: ['a'] })).toThrow(/clientId/);
    expect(() => validateKeysRequest({ secret: 'sec', ids: ['a'] })).toThrow(/clientId/);
  });

  it('rejects a non-string clientId or secret', () => {
    expect(() => validateKeysRequest({ clientId: 123, secret: 'sec', ids: ['a'] })).toThrow(/clientId/);
    expect(() => validateKeysRequest({ clientId: 'id', secret: 123, ids: ['a'] })).toThrow(/secret/);
  });

  it('rejects a missing/empty secret', () => {
    expect(() => validateKeysRequest({ clientId: 'id', secret: '', ids: ['a'] })).toThrow(/secret/);
  });

  it('rejects ids that is missing, empty, not an array, or contains a non-string', () => {
    expect(() => validateKeysRequest({ clientId: 'id', secret: 'sec' })).toThrow(/ids/);
    expect(() => validateKeysRequest({ clientId: 'id', secret: 'sec', ids: [] })).toThrow(/ids/);
    expect(() => validateKeysRequest({ clientId: 'id', secret: 'sec', ids: 'a' })).toThrow(/ids/);
    expect(() => validateKeysRequest({ clientId: 'id', secret: 'sec', ids: ['a', 123] })).toThrow(/ids/);
  });
});
