import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { decodeBroadcast, discover } from '../src/tuya/discovery.js';

const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

class FakeSocket extends EventEmitter {
  close = vi.fn();
  constructor(private readonly bindImpl: () => void) {
    super();
  }
  bind(): void {
    this.bindImpl();
  }
}

const { createSocketMock } = vi.hoisted(() => ({ createSocketMock: vi.fn() }));

vi.mock('node:dgram', () => ({
  default: { createSocket: createSocketMock },
  createSocket: createSocketMock,
}));

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

describe('discover', () => {
  it('closes a socket that fails to bind synchronously, and still resolves with the other port', async () => {
    const failingSocket = new FakeSocket(() => {
      throw new Error('EADDRINUSE');
    });
    const workingSocket = new FakeSocket(() => {
      // bind succeeds; simulate a broadcast arriving right after
      queueMicrotask(() => {
        const buf = frame(Buffer.from(JSON.stringify(wireAnnouncement)));
        workingSocket.emit('message', buf);
      });
    });
    createSocketMock.mockReturnValueOnce(failingSocket).mockReturnValueOnce(workingSocket);

    const result = await discover(10);

    expect(failingSocket.close).toHaveBeenCalled();
    expect(result).toEqual([decoded]);
  });
});
