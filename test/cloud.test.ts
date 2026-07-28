import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('undici', () => ({
  Agent: class {},
  fetch: fetchMock,
}));

const { TuyaCloud } = await import('../src/tuya/cloud.js');

function jsonResponse(body: unknown, status = 200) {
  return { status, json: async () => body };
}

const CLIENT_ID = 'client-id';
const SECRET = 'secret';
const VALID_ID = 'bf01000000000000000a'; // synthetic, 20 hex chars

beforeEach(() => {
  fetchMock.mockReset();
});

describe('TuyaCloud region validation', () => {
  it('rejects an unknown region', () => {
    // @ts-expect-error deliberately invalid region
    expect(() => new TuyaCloud(CLIENT_ID, SECRET, 'weaz')).toThrow(/unknown tuya region/i);
  });

  it('accepts a known region', () => {
    expect(() => new TuyaCloud(CLIENT_ID, SECRET, 'eu')).not.toThrow();
  });
});

describe('TuyaCloud device id validation (SSRF guard)', () => {
  it('rejects a path-traversal payload instead of signing it into a request', async () => {
    const cloud = new TuyaCloud(CLIENT_ID, SECRET, 'eu');
    await expect(cloud.getDevice('../../v1.0/users/all')).rejects.toThrow(/invalid tuya device id/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an id containing query-string injection', async () => {
    const cloud = new TuyaCloud(CLIENT_ID, SECRET, 'eu');
    await expect(cloud.getDevice('abc123?foo=bar')).rejects.toThrow(/invalid tuya device id/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a well-formed device id and requests the encoded path', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, result: { id: VALID_ID, name: 'Fan', local_key: 'x'.repeat(16), ip: '192.0.2.5', online: true } }),
    );
    const cloud = new TuyaCloud(CLIENT_ID, SECRET, 'eu');
    const device = await cloud.getDevice(VALID_ID);
    expect(device.id).toBe(VALID_ID);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain(`/v1.0/devices/${VALID_ID}`);
  });
});

describe('TuyaCloud error mapping', () => {
  it('maps a timeout/abort to a readable message without leaking internals', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('internal socket detail'), { name: 'TimeoutError' }));
    const cloud = new TuyaCloud(CLIENT_ID, SECRET, 'eu');
    await expect(cloud.authenticate()).rejects.toThrow(/timed out/i);
  });

  it('maps a generic network failure to a readable message', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const cloud = new TuyaCloud(CLIENT_ID, SECRET, 'eu');
    await expect(cloud.authenticate()).rejects.toThrow(/could not reach the tuya api/i);
  });

  it('maps an invalid-credentials response code without echoing the secret', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, code: 1004, msg: 'sign invalid' }));
    const cloud = new TuyaCloud(CLIENT_ID, SECRET, 'eu');
    const error = await cloud.authenticate().catch(e => e as Error);
    expect(error.message).toMatch(/credentials/i);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(CLIENT_ID);
  });

  it('surfaces a per-device failure message from Tuya without exposing credentials', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, code: 2010, msg: 'device not found' }));
    const cloud = new TuyaCloud(CLIENT_ID, SECRET, 'eu');
    await expect(cloud.getDevice(VALID_ID)).rejects.toThrow(/device not found/i);
  });
});
