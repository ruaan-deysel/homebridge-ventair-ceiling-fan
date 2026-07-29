import crypto from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';

export const TUYA_REGIONS = {
  eu: 'openapi.tuyaeu.com',
  us: 'openapi.tuyaus.com',
  cn: 'openapi.tuyacn.com',
  in: 'openapi.tuyain.com',
} as const;

export type TuyaRegion = keyof typeof TUYA_REGIONS;

export interface CloudDevice {
  id: string;
  name: string;
  key: string;
  ip: string;
  online: boolean;
}

const EMPTY_BODY_HASH = crypto.createHash('sha256').update('').digest('hex');

// Device IDs arrive from UDP broadcasts sent by ANY device on the LAN, and this ID is
// interpolated into a Tuya API path that gets signed with the user's own credentials.
// A hostile LAN device broadcasting a crafted gwId must not turn into an arbitrary
// authenticated Tuya API call. Real Tuya device IDs are 16-26 alphanumeric characters —
// NOT hex; codetheweb/tuyapi#481 reports ids containing letters past 'f'. Anchored and
// alphanumeric-only is still enough to reject traversal and query-injection payloads.
const DEVICE_ID_RE = /^[A-Za-z0-9]{16,26}$/;

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Errors worth re-trying on the alternate address family: the address resolved but the
 * connection itself never came up, which is exactly what `FALLBACK_AGENT` exists for.
 * Anything else (a timeout, a TLS failure, a response-stream error) is NOT retried —
 * retrying a timeout cost the user two full REQUEST_TIMEOUT_MS windows before they saw
 * any feedback at all, and the second attempt was never going to behave differently.
 */
const CONNECT_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENETDOWN', 'EHOSTDOWN', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'EADDRNOTAVAIL',
]);

function isConnectFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && CONNECT_ERROR_CODES.has(code);
}

/** Never let a raw transport error (which may embed request internals) reach the caller. */
function transportError(error: unknown): Error {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new Error('Tuya API request timed out', { cause: error });
  }
  return new Error('Could not reach the Tuya API — check your network connection', { cause: error });
}

/**
 * Tuya's token lives for `expire_time` seconds. Re-authenticate this far before it
 * actually lapses — the token is used by the very next request, and a token that expires
 * in flight surfaces to the user as a bogus "check your credentials" error.
 */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/**
 * Node's Happy Eyeballs connection racing (`autoSelectFamily`, on by default since
 * Node 20) tries the IPv6 (AAAA) address alongside the IPv4 one. On a host with no
 * IPv6 route the IPv6 attempt fails instantly with ENETUNREACH, which poisons the
 * shared attempt loop so the IPv4 attempt that would have succeeded times out too.
 * Reported upstream against Tuya's own Homebridge plugin, same API hosts:
 * https://github.com/tuya/tuya-homebridge/issues/412
 * Measured on the target bridge: default agent ETIMEDOUT ~810ms; `autoSelectFamily:
 * false` alone succeeds in ~820ms.
 *
 * Deliberately `autoSelectFamily: false` only — NOT `family: 4`. Forcing IPv4 would
 * break a genuinely IPv6-only host reaching Tuya's dual-stack API; disabling the race
 * just lets normal DNS resolution order decide, which is enough to stop the poisoning.
 *
 * This must stay a per-agent setting on this module-scoped `https.Agent`, never
 * `net.setDefaultAutoSelectFamily(false)` process-wide — Homebridge runs many plugins
 * in one process, and flipping global socket behaviour for all of them because one
 * cloud API has a broken IPv6 attempt is not this plugin's call to make.
 *
 * (An earlier version of this fix used a separately-installed `undici` package's
 * `Agent` as `dispatcher` for Node's global `fetch`. That fails with
 * `ERR_INVALID_ARG_TYPE` — Node's built-in `fetch` uses its own internal undici
 * instance, which rejects a dispatcher built from a different module instance. Plain
 * `https.request` has no such internal-instance requirement.)
 *
 * `autoSelectFamily: false` alone just falls back to plain DNS resolution order,
 * which is whatever the resolver happens to hand back first — on a host where
 * AAAA sorts first with no usable IPv6 route, that reproduces the exact
 * tuya/tuya-homebridge#412 bug this was meant to fix. `lookup` below resolves
 * all addresses and explicitly prefers an IPv4 one when present, while still
 * falling back to IPv6 on an IPv6-only host — so neither ordering luck nor
 * IPv6-only breakage decides the outcome.
 *
 * A single preferred-family lookup only picks the address ONCE though — if that one
 * address is reachable by DNS but refuses the TCP connection (routing black hole,
 * firewall, a dual-stack host whose IPv4 path is broken specifically), there was no
 * way back to the other family and the whole request failed outright. `AGENT` (IPv4
 * preferred) and `FALLBACK_AGENT` (IPv6 preferred) below are used one after the other
 * by `request()` so a CONNECT failure on the preferred family gets exactly one retry
 * on the alternate family before giving up, without losing the IPv4-first preference
 * or the IPv6-only fallback on the normal, non-retry path.
 */
const AGENT = new https.Agent({ autoSelectFamily: false, keepAlive: true, lookup: makeLookup(4) });
const FALLBACK_AGENT = new https.Agent({ autoSelectFamily: false, keepAlive: true, lookup: makeLookup(6) });

/**
 * Resolves `hostname` and prefers an address of `preferredFamily` when one exists,
 * falling back to whatever else is available (e.g. IPv6 on an IPv4-preferring lookup
 * used against an IPv6-only host). See the `AGENT`/`FALLBACK_AGENT` comment above —
 * tuya/tuya-homebridge#412.
 */
function makeLookup(preferredFamily: 4 | 6) {
  return (
    hostname: string,
    options: dns.LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ): void => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err, '', 0);
        return;
      }
      const list = addresses as dns.LookupAddress[];
      if (list.length === 0) {
        callback(Object.assign(new Error(`No addresses found for ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
        return;
      }
      const preferred = list.find(a => a.family === preferredFamily);
      const chosen = preferred ?? [...list].sort((a, b) => a.family - b.family)[0];
      callback(null, chosen.address, chosen.family);
    });
  };
}

interface TuyaResponseBody<T> {
  success: boolean;
  msg?: string;
  code?: number;
  result: T;
}

/**
 * Tuya signs requests as HMAC-SHA256 over clientId + [token] + timestamp + nonce + stringToSign.
 * The access secret grants full account control and must never be persisted.
 */
export class TuyaCloud {
  constructor(
    private readonly clientId: string,
    private readonly secret: string,
    region: TuyaRegion,
  ) {
    const host = TUYA_REGIONS[region];
    if (!host) {
      throw new Error(`Unknown Tuya region "${String(region)}"`);
    }
    this.host = host;
  }

  private readonly host: string;
  private token?: string;
  private tokenExpiresAt = 0;

  private sign(payload: string): string {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('hex').toUpperCase();
  }

  private async call<T>(path: string): Promise<T> {
    const t = Date.now().toString();
    const nonce = crypto.randomUUID();
    const stringToSign = `GET\n${EMPTY_BODY_HASH}\n\n${path}`;
    const payload = this.token
      ? this.clientId + this.token + t + nonce + stringToSign
      : this.clientId + t + nonce + stringToSign;

    const headers = {
      client_id: this.clientId,
      sign: this.sign(payload),
      t,
      nonce,
      sign_method: 'HMAC-SHA256',
      ...(this.token ? { access_token: this.token } : {}),
    };

    let statusCode: number | undefined;
    let raw: string;
    try {
      ({ statusCode, body: raw } = await this.request(path, headers, AGENT));
    } catch (firstError) {
      // Only a CONNECT-class failure earns a retry: the preferred-family address resolved
      // fine but the connection never came up (routing black hole, broken IPv4 path on an
      // otherwise-fine dual-stack host, etc.), which is precisely the tuya-homebridge#412
      // case FALLBACK_AGENT exists for. Anything else — a timeout above all — propagates
      // immediately rather than costing a second full REQUEST_TIMEOUT_MS window.
      if (!isConnectFailure(firstError)) {
        throw transportError(firstError);
      }
      try {
        ({ statusCode, body: raw } = await this.request(path, headers, FALLBACK_AGENT));
      } catch (secondError) {
        // The first attempt's error is discarded deliberately — it's a same-class
        // connection failure and the retry's own error is the one that matters here.
        throw transportError(secondError);
      }
    }

    let body: TuyaResponseBody<T>;
    try {
      body = JSON.parse(raw) as TuyaResponseBody<T>;
    } catch {
      throw new Error(`Tuya API returned an unreadable response (HTTP ${statusCode})`);
    }

    if (!body.success) {
      // Tuya's own msg/code are safe to surface; never include clientId/secret here.
      if (body.code === 1004 || body.code === 1010) {
        throw new Error('Tuya rejected the Access ID / Secret — check your credentials');
      }
      throw new Error(body.msg ? `Tuya API error: ${body.msg}` : `Tuya API request failed (HTTP ${statusCode})`);
    }
    return body.result;
  }

  private request(
    path: string,
    headers: Record<string, string>,
    agent: https.Agent,
  ): Promise<{ statusCode?: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        { hostname: this.host, path, method: 'GET', headers, agent, timeout: REQUEST_TIMEOUT_MS },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk as Buffer));
          res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => {
        req.destroy(Object.assign(new Error('Tuya API request timed out'), { name: 'TimeoutError' }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  async authenticate(): Promise<void> {
    // Clear first: `call()` signs with `this.token` when it is set, and the token endpoint
    // must be signed WITHOUT one — re-authenticating on an expired token would otherwise
    // sign the refresh with the very token that just lapsed.
    this.token = undefined;
    this.tokenExpiresAt = 0;
    const result = await this.call<{ access_token: string; expire_time?: number }>('/v1.0/token?grant_type=1');
    this.token = result.access_token;
    // `expire_time` is seconds (Tuya returns 7200). A response without it is treated as
    // already expired, so the next call re-authenticates rather than reusing it forever.
    this.tokenExpiresAt = typeof result.expire_time === 'number'
      ? Date.now() + result.expire_time * 1000 - TOKEN_EXPIRY_MARGIN_MS
      : 0;
  }

  /** Re-authenticate a token that has expired (or is about to) before using it. */
  private async ensureToken(): Promise<void> {
    if (this.token && Date.now() >= this.tokenExpiresAt) {
      await this.authenticate();
    }
  }

  async getDevice(id: string): Promise<CloudDevice> {
    if (!DEVICE_ID_RE.test(id)) {
      throw new Error(`Invalid Tuya device ID: "${id}"`);
    }
    await this.ensureToken();
    const d = await this.call<{ id: string; name: string; local_key: string; ip: string; online: boolean }>(
      `/v1.0/devices/${encodeURIComponent(id)}`,
    );
    return { id: d.id, name: d.name, key: d.local_key, ip: d.ip, online: d.online };
  }
}
