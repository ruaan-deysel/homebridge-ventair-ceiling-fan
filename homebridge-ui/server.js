import process from 'node:process';
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { discover } from '../dist/tuya/discovery.js';
import { TUYA_REGIONS, TuyaCloud } from '../dist/tuya/cloud.js';

/**
 * Validates the `/keys` request payload's shape BEFORE a `TuyaCloud` instance is ever
 * constructed (which starts signing/authenticating requests) — a malformed request must
 * never reach the network layer at all. Pulled out of the handler for the same reason as
 * `fetchKeys` above: testable without booting the IPC-bound `HomebridgePluginUiServer`.
 * Throws `RequestError`; returns nothing on success.
 */
export function validateKeysRequest(body) {
  if (typeof body !== 'object' || body === null) {
    throw new RequestError('request body must be an object');
  }
  const { clientId, secret, ids, region } = body;
  if (typeof clientId !== 'string' || !clientId) {
    throw new RequestError('clientId must be a non-empty string');
  }
  if (typeof secret !== 'string' || !secret) {
    throw new RequestError('secret must be a non-empty string');
  }
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === 'string')) {
    throw new RequestError('ids must be a non-empty array of strings');
  }
  // The region picks the Tuya data centre the credentials are signed against, so it must
  // be one of the four the UI offers — never whatever string the client happened to send.
  // Absent means "unspecified" and defaults to 'eu' below; anything else is rejected
  // outright rather than silently falling back, because the wrong data centre surfaces as
  // a baffling "check your credentials" error.
  if (region !== undefined && !Object.hasOwn(TUYA_REGIONS, region)) {
    throw new RequestError(`region must be one of: ${Object.keys(TUYA_REGIONS).join(', ')}`);
  }
}

/**
 * The `/keys` handler body, extracted so it is reachable from tests (see `fetchKeys`) and
 * so validation runs on the RAW request payload. Destructuring in the handler's parameter
 * list used to throw a raw TypeError on a null/non-object body — before `validateKeysRequest`
 * could run — which is exactly the case the validator exists for.
 */
export async function handleKeysRequest(body) {
  validateKeysRequest(body);
  let cloud;
  try {
    cloud = new TuyaCloud(body.clientId, body.secret, body.region ?? 'eu');
    await cloud.authenticate();
  } catch (error) {
    throw new RequestError('Could not fetch keys', { message: error.message });
  }
  return fetchKeys(cloud, body.ids);
}

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
      // `||`, not `??`: an empty-string `.message` (e.g. `new Error()` with no message
      // set) is not nullish, so `??` let it straight through and rendered a blank error
      // in the UI. Anything falsy — missing, undefined, or empty — falls back here.
      failed.push({ id: ids[i], message: result.reason?.message || 'Unknown error' });
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
    this.onRequest('/keys', body => handleKeysRequest(body));

    this.ready();
  }
}

if (process.send) {
  new VentairUiServer();
}
