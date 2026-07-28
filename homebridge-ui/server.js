import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { discover } from '../dist/tuya/discovery.js';
import { TuyaCloud } from '../dist/tuya/cloud.js';

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
      try {
        const cloud = new TuyaCloud(clientId, secret, region ?? 'eu');
        await cloud.authenticate();
        return await Promise.all(ids.map(id => cloud.getDevice(id)));
      } catch (error) {
        throw new RequestError('Could not fetch keys', { message: error.message });
      }
    });

    this.ready();
  }
}

(() => new VentairUiServer())();
