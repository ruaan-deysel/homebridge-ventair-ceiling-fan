import { describe, expect, it } from 'vitest';
import { fetchKeys } from '../homebridge-ui/server.js';

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

  it('never lets a raw error object without .message leak an unhelpful value', async () => {
    const cloud = fakeCloud({ id1: Object.assign(new Error(), { message: '' }) });
    const { failed } = await fetchKeys(cloud, ['id1']);
    expect(failed[0].id).toBe('id1');
    expect(typeof failed[0].message).toBe('string');
  });
});
