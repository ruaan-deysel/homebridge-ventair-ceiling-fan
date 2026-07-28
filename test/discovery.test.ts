import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeBroadcast } from '../src/tuya/discovery.js';

const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

function frame(payload: Buffer): Buffer {
  // 20-byte header + payload + 8-byte CRC/suffix, matching Tuya's 55AA framing
  return Buffer.concat([Buffer.alloc(20), payload, Buffer.alloc(8)]);
}

// Wire format uses Tuya's `gwId` field; decodeBroadcast normalizes it to `id`.
const wireAnnouncement = { gwId: 'bf01000000000000000a', ip: '192.0.2.11', version: '3.3' };
const decoded = { id: 'bf01000000000000000a', ip: '192.0.2.11', version: '3.3' };

describe('decodeBroadcast', () => {
  it('decodes a plaintext announcement', () => {
    const buf = frame(Buffer.from(JSON.stringify(wireAnnouncement)));
    expect(decodeBroadcast(buf)).toEqual(decoded);
  });

  it('decodes an AES-ECB encrypted announcement', () => {
    const c = crypto.createCipheriv('aes-128-ecb', UDP_KEY, null);
    const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(wireAnnouncement))), c.final()]);
    expect(decodeBroadcast(frame(body))).toEqual(decoded);
  });

  it('returns null for undecodable rubbish rather than throwing', () => {
    expect(decodeBroadcast(frame(Buffer.from('not json at all')))).toBeNull();
  });

  it('returns null when the frame is too short to contain a payload', () => {
    expect(decodeBroadcast(Buffer.alloc(10))).toBeNull();
  });
});
