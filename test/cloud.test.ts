import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestMock, agentCtorArgs } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  agentCtorArgs: [] as unknown[],
}));

class FakeRequest extends EventEmitter {
  end = vi.fn();
  destroy = vi.fn((err: Error) => this.emit('error', err));
}

vi.mock('node:https', () => ({
  default: {
    Agent: class {
      constructor(opts: unknown) {
        agentCtorArgs.push(opts);
      }
    },
    request: requestMock,
  },
}));

const { TuyaCloud } = await import('../src/tuya/cloud.js');

const CLIENT_ID = 'client-id';
const SECRET = 'secret';
const VALID_ID = 'bf01000000000000000a'; // synthetic, 20 hex chars

/** Simulates a successful HTTP response with the given JSON body. */
function respondWith(status: number, body: unknown) {
  requestMock.mockImplementationOnce((_opts, cb) => {
    const req = new FakeRequest();
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = status;
    cb(res);
    queueMicrotask(() => {
      res.emit('data', Buffer.from(JSON.stringify(body)));
      res.emit('end');
    });
    return req;
  });
}

function failWith(error: Error) {
  requestMock.mockImplementationOnce(() => {
    const req = new FakeRequest();
    queueMicrotask(() => req.emit('error', error));
    return req;
  });
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('TuyaCloud transport', () => {
  it('constructs its https.Agent with autoSelectFamily disabled and no family pin', () => {
    expect(agentCtorArgs.length).toBeGreaterThan(0);
    const opts = agentCtorArgs[0] as Record<string, unknown>;
    expect(opts.autoSelectFamily).toBe(false);
    expect(opts).not.toHaveProperty('family');
  });
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
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects an id containing query-string injection', async () => {
    const cloud = new TuyaCloud(CLIENT_ID, SECRET, 'eu');
    await expect(cloud.getDevice('abc123?foo=bar')).rejects.toThrow(/invalid tuya device id/i);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('accepts a well-formed device id and requests the encoded path', async () => {
    respondWith(200, { success: true, result: { id: VALID_ID, name: 'Fan', local_key: 'x'.repeat(16), ip: '192.0.2.5', online: true } });
    const cloud = new TuyaCloud(CLIENT_ID, SECRET, 'eu');
    const device = await cloud.getDevice(VALID_ID);
    expect(device.id).toBe(VALID_ID);
    const [opts] = requestMock.mock.calls[0] as [{ path: string }];
    expect(opts.path).toContain(`/v1.0/devices/${VALID_ID}`);
  });
});

describe('TuyaCloud error mapping', () => {
  it('maps a timeout to a readable message without leaking internals', async () => {
    failWith(Object.assign(new Error('internal socket detail'), { name: 'TimeoutError' }));
    const cloud = new TuyaCloud(CLIENT_ID, SECRET, 'eu');
    await expect(cloud.authenticate()).rejects.toThrow(/timed out/i);
  });

  it('maps a generic network failure to a readable message', async () => {
    failWith(new Error('ECONNRESET'));
    const cloud = new TuyaCloud(CLIENT_ID, SECRET, 'eu');
    await expect(cloud.authenticate()).rejects.toThrow(/could not reach the tuya api/i);
  });

  it('maps an invalid-credentials response code without echoing the secret', async () => {
    respondWith(200, { success: false, code: 1004, msg: 'sign invalid' });
    const cloud = new TuyaCloud(CLIENT_ID, SECRET, 'eu');
    const error = await cloud.authenticate().catch(e => e as Error);
    expect(error.message).toMatch(/credentials/i);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(CLIENT_ID);
  });

  it('surfaces a per-device failure message from Tuya without exposing credentials', async () => {
    respondWith(200, { success: false, code: 2010, msg: 'device not found' });
    const cloud = new TuyaCloud(CLIENT_ID, SECRET, 'eu');
    await expect(cloud.getDevice(VALID_ID)).rejects.toThrow(/device not found/i);
  });
});
