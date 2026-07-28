import crypto from 'node:crypto';
import { Agent, fetch } from 'undici';

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
// authenticated Tuya API call. Real Tuya device IDs are 16-26 hex characters.
const DEVICE_ID_RE = /^[0-9a-f]{16,26}$/i;

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Node's Happy Eyeballs connection racing (`net.setDefaultAutoSelectFamily`, on by
 * default since Node 20) tries the IPv6 (AAAA) address alongside the IPv4 one. On a
 * host with no IPv6 route the IPv6 attempt fails instantly with ENETUNREACH, which
 * poisons the shared attempt loop so the IPv4 attempt that would have succeeded times
 * out too. Confirmed against Tuya's own openapi hosts and reported upstream against
 * Tuya's own Homebridge plugin: https://github.com/tuya/tuya-homebridge/issues/412
 * Measured on the target bridge: default behaviour ETIMEDOUT ~800ms; IPv4-only
 * dispatcher succeeds in ~800ms.
 *
 * This is scoped to TuyaCloud's own fetch calls via an explicit undici Agent, not
 * `net.setDefaultAutoSelectFamily(false)` / `dns.setDefaultResultOrder('ipv4first')` —
 * Homebridge runs many plugins in one process, and flipping global socket/DNS
 * behaviour for all of them because one cloud API has a broken IPv6 route is not this
 * plugin's call to make.
 */
const IPV4_ONLY_DISPATCHER = new Agent({ connect: { family: 4, autoSelectFamily: false } });

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

    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(`https://${this.host}${path}`, {
        headers: {
          client_id: this.clientId,
          sign: this.sign(payload),
          t,
          nonce,
          sign_method: 'HMAC-SHA256',
          ...(this.token ? { access_token: this.token } : {}),
        },
        dispatcher: IPV4_ONLY_DISPATCHER,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Never let a raw error (which may embed request internals) bubble up — surface
      // only whether it was a timeout or some other network failure.
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new Error('Tuya API request timed out', { cause: error });
      }
      throw new Error('Could not reach the Tuya API — check your network connection', { cause: error });
    }

    let body: { success: boolean; msg?: string; code?: number; result: T };
    try {
      body = await res.json() as { success: boolean; msg?: string; code?: number; result: T };
    } catch {
      throw new Error(`Tuya API returned an unreadable response (HTTP ${res.status})`);
    }

    if (!body.success) {
      // Tuya's own msg/code are safe to surface; never include clientId/secret here.
      if (body.code === 1004 || body.code === 1010) {
        throw new Error('Tuya rejected the Access ID / Secret — check your credentials');
      }
      throw new Error(body.msg ? `Tuya API error: ${body.msg}` : `Tuya API request failed (HTTP ${res.status})`);
    }
    return body.result;
  }

  async authenticate(): Promise<void> {
    const result = await this.call<{ access_token: string }>('/v1.0/token?grant_type=1');
    this.token = result.access_token;
  }

  async getDevice(id: string): Promise<CloudDevice> {
    if (!DEVICE_ID_RE.test(id)) {
      throw new Error(`Invalid Tuya device ID: "${id}"`);
    }
    const d = await this.call<{ id: string; name: string; local_key: string; ip: string; online: boolean }>(
      `/v1.0/devices/${encodeURIComponent(id)}`,
    );
    return { id: d.id, name: d.name, key: d.local_key, ip: d.ip, online: d.online };
  }
}
