import { createRequire } from 'node:module';

/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'HomebridgeVentairCeilingFan';

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = 'homebridge-ventair-ceiling-fan';

/**
 * Reported to HomeKit as the accessory's firmware revision. Read from package.json rather
 * than written here: it was hardcoded, so it silently kept reporting 2.0.0 after the
 * version moved on, and every release would have to remember to update a second place.
 *
 * `createRequire` rather than a JSON import: this package is ESM under `module: nodenext`
 * without `resolveJsonModule`, and import attributes for JSON are still awkward across the
 * supported Node range. From `dist/settings.js`, `../package.json` is the package root.
 */
const require = createRequire(import.meta.url);
export const PLUGIN_VERSION: string = (require('../package.json') as { version: string }).version;
