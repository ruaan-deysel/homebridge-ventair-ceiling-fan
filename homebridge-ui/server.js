import process from 'node:process';
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { discover } from '../dist/tuya/discovery.js';
import { TuyaCloud } from '../dist/tuya/cloud.js';

/**
 * Pulled out of the `/keys` handler so it can be unit tested without booting the
 * IPC-bound `HomebridgePluginUiServer` (its constructor calls `process.exit(1)`
 * outside a child process).
 *
 * One bad device (rate limit, removed from the account, transient network error)
 * must cost one device, not the whole batch — same skip-bad-device policy as
 * parseDevices() and platform.ts's per-device setup. `error.message` here is always
 * TuyaCloud's own thrown message (Tuya's body.msg / a network-class description) —
 * never the raw error object — so the Access ID/Secret can never leak into it.
 */
export async function fetchKeys(cloud, ids) {
  const results = await Promise.allSettled(ids.map(id => cloud.getDevice(id)));
  const devices = [];
  const failed = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      devices.push(result.value);
    } else {
      failed.push({ id: ids[i], message: result.reason?.message ?? 'Unknown error' });
    }
  });
  return { devices, failed };
}

class VentairUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    // A single broadcast interval can miss a device; 28s gives multiple announcement
    // cycles a chance without making the user wait too long for feedback.
    this.onRequest('/discover', async () => {
      try {
        return await discover(28_000);
      } catch (error) {
        throw new RequestError('Discovery failed', { message: error.message });
      }
    });

    // Credentials arrive per-request and are never stored anywhere.
    this.onRequest('/keys', async ({ clientId, secret, region, ids }) => {
      if (!clientId || !secret) {
        throw new RequestError('Access ID and Secret are required');
      }
      let cloud;
      try {
        cloud = new TuyaCloud(clientId, secret, region ?? 'eu');
        await cloud.authenticate();
      } catch (error) {
        throw new RequestError('Could not fetch keys', { message: error.message });
      }
      return fetchKeys(cloud, ids);
    });

    this.ready();
  }
}

if (process.send) {
  new VentairUiServer();
}
