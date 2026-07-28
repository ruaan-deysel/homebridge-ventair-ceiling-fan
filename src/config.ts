import type { Logging } from 'homebridge';
import { z } from 'zod';

export const PROTOCOL_VERSIONS = ['3.1', '3.2', '3.3', '3.4', '3.5'] as const;

export const DeviceSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{16,26}$/i, 'Tuya device ID should be 16-26 hex characters'),
  key: z.string().length(16, 'Tuya local keys are exactly 16 characters'),
  name: z.string().min(1, 'Device name cannot be empty'),
  hasLight: z.boolean().default(false),
  exposeModeSwitches: z.boolean().default(false),
  // Matter is beta in Homebridge and must be enabled on the bridge first — most users'
  // bridges won't have it configured, so this stays off unless explicitly turned on.
  exposeMatter: z.boolean().default(false),
  ip: z.ipv4('Not a valid IPv4 address').optional(),
  version: z.enum(PROTOCOL_VERSIONS).default('3.3'),
});

export type VentairDevice = z.infer<typeof DeviceSchema>;

/**
 * Parse the `devices` array, dropping entries that fail validation.
 *
 * A single mistyped key must cost the user one fan, not the whole bridge — with eight
 * devices configured, failing the entire platform on one bad entry is the wrong trade.
 */
export function parseDevices(config: { devices?: unknown }, log: Pick<Logging, 'warn'>): VentairDevice[] {
  if (!Array.isArray(config.devices)) {
    log.warn('No devices configured. Add at least one fan in the plugin settings.');
    return [];
  }

  const devices: VentairDevice[] = [];

  for (const [index, raw] of config.devices.entries()) {
    const result = DeviceSchema.safeParse(raw);
    if (result.success) {
      devices.push(result.data);
      continue;
    }
    // Identify by name or position — never echo the key back into the log.
    const label = describe(raw, index);
    log.warn(`Skipping ${label} — invalid configuration:\n${z.prettifyError(result.error)}`);
  }

  return devices;
}

function describe(raw: unknown, index: number): string {
  const name = raw && typeof raw === 'object' && 'name' in raw ? (raw as { name: unknown }).name : undefined;
  return typeof name === 'string' && name.length > 0 ? `device "${name}"` : `device at position ${index + 1}`;
}
