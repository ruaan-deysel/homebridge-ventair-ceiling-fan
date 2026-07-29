import dgram from 'node:dgram';
import crypto from 'node:crypto';

/**
 * Tuya broadcasts device announcements on these ports. The AES key is a published
 * constant shared by every Tuya device — it protects nothing and is documented in
 * tinytuya and localtuya. It is not a secret and grants no device control.
 */
const UDP_PORTS = [6666, 6667] as const;
// ECB is mandated by Tuya's wire protocol: the key is public, this code only ever
// DECRYPTS broadcast announcements, and there is no confidentiality to protect. Do
// not "fix" this to GCM/CBC — that breaks discovery against real devices.
const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

const HEADER_BYTES = 20;
const SUFFIX_BYTES = 8;

export interface DiscoveredDevice {
  id: string;
  ip: string;
  version: string;
}

/** Decode one broadcast frame. Returns null when the payload isn't a device announcement. */
export function decodeBroadcast(buf: Buffer): DiscoveredDevice | null {
  if (buf.length <= HEADER_BYTES + SUFFIX_BYTES) {
    return null;
  }
  const body = buf.subarray(HEADER_BYTES, buf.length - SUFFIX_BYTES);
  const parsed = tryParse(body) ?? tryParse(tryDecrypt(body));
  if (!parsed?.gwId || !parsed.ip) {
    return null;
  }
  return { id: String(parsed.gwId), ip: String(parsed.ip), version: String(parsed.version ?? '3.3') };
}

function tryParse(body: Buffer | null): Record<string, unknown> | null {
  if (!body) {
    return null;
  }
  try {
    return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function tryDecrypt(body: Buffer): Buffer | null {
  try {
    const d = crypto.createDecipheriv('aes-128-ecb', UDP_KEY, null);
    return Buffer.concat([d.update(body), d.final()]);
  } catch {
    return null;
  }
}

/**
 * Listen for broadcasts and return everything heard within `timeoutMs`.
 * Devices announce every few seconds, so 10s is generally ample.
 */
export function discover(timeoutMs = 10_000): Promise<DiscoveredDevice[]> {
  return new Promise(resolve => {
    const found = new Map<string, DiscoveredDevice>();
    const sockets: dgram.Socket[] = [];

    for (const port of UDP_PORTS) {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      // A port already in use must not take down the other listener. Guarded like every
      // other close() here: an asynchronous bind error fires this on a socket that was
      // never bound, and close() then throws from inside an event handler — a path no
      // caller can catch, which takes the whole Homebridge process down.
      socket.on('error', () => {
        try {
          socket.close();
        } catch {
          // never bound, or already closed
        }
      });
      socket.on('message', msg => {
        const device = decodeBroadcast(msg);
        if (device) {
          found.set(device.id, device);
        }
      });
      sockets.push(socket);
      try {
        socket.bind(port);
      } catch {
        // synchronous bind failure — close it now so it isn't leaked; the other port may still work
        try {
          socket.close();
        } catch {
          // already unusable
        }
      }
    }

    setTimeout(() => {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          // already closed
        }
      }
      resolve([...found.values()]);
    }, timeoutMs).unref?.();
  });
}
