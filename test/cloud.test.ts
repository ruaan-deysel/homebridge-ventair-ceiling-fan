import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestMock, agentCtorArgs, dnsLookupMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  agentCtorArgs: [] as unknown[],
  dnsLookupMock: vi.fn(),
}));

class FakeRequest extends EventEmitter {
  end = vi.fn();
  destroy = vi.fn((err: Error) => this.emit('error', err));
}

vi.mock('node:https', () => ({
  default: {
    Agent: class {
      // Identifies which of the (two) module-level Agent instances a given
      // https.request() call was actually issued through, for the dual-stack
      // retry tests below.
      id = agentCtorArgs.length;
      constructor(opts: unknown) {
        agentCtorArgs.push(opts);
      }
    },
    request: requestMock,
  },
}));

vi.mock('node:dns', () => ({
  default: { lookup: dnsLookupMock },
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

  describe('custom DNS lookup (tuya/tuya-homebridge#412)', () => {
    // Exercise the real `lookup` function installed on the Agent — not a
    // reimplementation of it — by pulling it off the captured ctor args and
    // driving it against a mocked node:dns.
    function lookupFn() {
      const opts = agentCtorArgs[0] as { lookup: (
        hostname: string,
        options: unknown,
        cb: (err: Error | null, address: string, family: number) => void,
      ) => void };
      return opts.lookup;
    }

    it('prefers the IPv4 address when the resolver returns AAAA first but IPv6 is unusable', async () => {
      dnsLookupMock.mockImplementation((_host, _opts, cb) => {
        cb(null, [
          { address: '2001:db8::1', family: 6 },
          { address: '192.0.2.1', family: 4 },
        ]);
      });
      const result = await new Promise<{ address: string; family: number }>(resolve => {
        lookupFn()('example.test', {}, (_err, address, family) => resolve({ address, family }));
      });
      expect(result).toEqual({ address: '192.0.2.1', family: 4 });
    });

    it('falls back to the IPv6 address on an IPv6-only host', async () => {
      dnsLookupMock.mockImplementation((_host, _opts, cb) => {
        cb(null, [{ address: '2001:db8::1', family: 6 }]);
      });
      const result = await new Promise<{ address: string; family: number }>(resolve => {
        lookupFn()('example.test', {}, (_err, address, family) => resolve({ address, family }));
      });
      expect(result).toEqual({ address: '2001:db8::1', family: 6 });
    });
  });
});

describe('TuyaCloud dual-stack retry (tuya/tuya-homebridge#412)', () => {
  it('retries on the alternate address family when the preferred one fails to CONNECT', async () => {
    // First attempt (through the IPv4-preferring agent) fails at the connection level —
    // not an HTTP error response, an actual transport failure — then the second attempt
    // must go out through a DIFFERENT agent instance (the IPv6-preferring one) rather
    // than giving up after a single family.
    failWith(Object.assign(new Error('connect ECONNREFUSED 192.0.2.1:443'), { code: 'ECONNREFUSED' }));
    respondWith(200, { success: true, result: { access_token: 'tok' } });

    const cloud = new TuyaCloud(CLIENT_ID, SECRET, 'eu');
    await expect(cloud.authenticate()).resolves.toBeUndefined();

    expect(requestMock).toHaveBeenCalledTimes(2);
    const [firstOpts] = requestMock.mock.calls[0] as [{ agent: { id: number } }];
    const [secondOpts] = requestMock.mock.calls[1] as [{ agent: { id: number } }];
    expect(firstOpts.agent.id).not.toBe(secondOpts.agent.id);
  });

  it('surfaces a readable error when BOTH address families fail to connect', async () => {
    failWith(new Error('connect ECONNREFUSED 192.0.2.1:443'));
    failWith(new Error('connect ECONNREFUSED 2001:db8::1:443'));

    const cloud = new TuyaCloud(CLIENT_ID, SECRET, 'eu');
    await expect(cloud.authenticate()).rejects.toThrow(/could not reach the tuya api/i);
    expect(requestMock).toHaveBeenCalledTimes(2);
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

  it('accepts a real-world alphanumeric (non-hex) device id', async () => {
    // codetheweb/tuyapi#481 — real ids contain letters past 'f'; a hex-only guard
    // rejected every such fan before it could ever fetch its key.
    const nonHex = 'bf97ae127518bd821b1mdo';
    respondWith(200, { success: true, result: { id: nonHex, name: 'Fan', local_key: 'x'.repeat(16), ip: '192.0.2.5', online: true } });
    const cloud = new TuyaCloud(CLIENT_ID, SECRET, 'eu');
    await expect(cloud.getDevice(nonHex)).resolves.toMatchObject({ id: nonHex });
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
    // A failure retries once on the alternate address family (see the dual-stack retry
    // describe block above) — queue the timeout twice so both attempts see it.
    failWith(Object.assign(new Error('internal socket detail'), { name: 'TimeoutError' }));
    failWith(Object.assign(new Error('internal socket detail'), { name: 'TimeoutError' }));
    const cloud = new TuyaCloud(CLIENT_ID, SECRET, 'eu');
    await expect(cloud.authenticate()).rejects.toThrow(/timed out/i);
  });

  it('maps a generic network failure to a readable message', async () => {
    failWith(new Error('ECONNRESET'));
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
