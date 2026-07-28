import crypto from 'node:crypto';

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
    this.host = TUYA_REGIONS[region];
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

    const res = await fetch(`https://${this.host}${path}`, {
      headers: {
        client_id: this.clientId,
        sign: this.sign(payload),
        t,
        nonce,
        sign_method: 'HMAC-SHA256',
        ...(this.token ? { access_token: this.token } : {}),
      },
    });

    const body = await res.json() as { success: boolean; msg?: string; result: T };
    if (!body.success) {
      throw new Error(body.msg ?? 'Tuya API request failed');
    }
    return body.result;
  }

  async authenticate(): Promise<void> {
    const result = await this.call<{ access_token: string }>('/v1.0/token?grant_type=1');
    this.token = result.access_token;
  }

  async getDevice(id: string): Promise<CloudDevice> {
    const d = await this.call<{ id: string; name: string; local_key: string; ip: string; online: boolean }>(`/v1.0/devices/${id}`);
    return { id: d.id, name: d.name, key: d.local_key, ip: d.ip, online: d.online };
  }
}
