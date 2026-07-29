import type { Logging } from 'homebridge';
import { z } from 'zod';

export const PROTOCOL_VERSIONS = ['3.1', '3.2', '3.3', '3.4', '3.5'] as const;

export const DeviceSchema = z.object({
  // Alphanumeric, NOT hex: real Tuya ids contain letters past 'f' (codetheweb/tuyapi#481
  // reports e.g. one ending "1mdo"), and a hex-only rule silently dropped those fans.
  // Stays anchored and alphanumeric-only — the id is interpolated into signed cloud API
  // paths, so path-traversal and query-injection payloads must still be rejected here.
  id: z.string().regex(/^[A-Za-z0-9]{16,26}$/, 'Tuya device ID should be 16-26 letters or digits'),
  key: z.string().length(16, 'Tuya local keys are exactly 16 characters'),
  name: z.string().min(1, 'Device name cannot be empty'),
  hasLight: z.boolean().default(false),
  exposeModeSwitches: z.boolean().default(false),
  ip: z.ipv4('Not a valid IPv4 address').optional(),
  // Deliberately no `.default('3.3')`: a defaulted value is indistinguishable from an
  // explicitly configured one, which made a discovered 3.4/3.5 fan unreachable because
  // the default silently won. Absent here means "not specified" so discovery can fill it
  // in; platform.ts applies the 3.3 fallback at construction.
  version: z.enum(PROTOCOL_VERSIONS).optional(),
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
  // Only ids that actually passed validation are recorded, so a rejected entry can never
  // reserve an id against a later, valid one.
  const seen = new Set<string>();

  for (const [index, raw] of config.devices.entries()) {
    const result = DeviceSchema.safeParse(raw);
    if (result.success) {
      // Same id twice means the same HAP UUID twice, which showed up as duplicate fans
      // in the Home app. Keep the first, drop the rest — same policy as any invalid entry.
      if (seen.has(result.data.id)) {
        log.warn(`Skipping ${describe(raw, index)} — duplicate device ID; it is already configured.`);
        continue;
      }
      seen.add(result.data.id);
      devices.push(result.data);
      continue;
    }
    // Identify by name or position — never echo the key back into the log.
    const label = describe(raw, index);
    log.warn(`Skipping ${label} — invalid configuration:\n${z.prettifyError(result.error)}`);
  }

  return devices;
}

/**
 * Every device ID present in the RAW config, valid entry or not.
 *
 * Stale-accessory cleanup must key off this, never off `parseDevices` — an entry that
 * failed validation is still a fan the user configured, and unregistering its accessory
 * over a mistyped key discards its room, scenes and automations irreversibly.
 * Defensive by necessity: a raw entry may be any shape at all.
 */
export function configuredDeviceIds(config: { devices?: unknown }): string[] {
  if (!Array.isArray(config.devices)) {
    return [];
  }
  return config.devices
    .map(raw => (raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function describe(raw: unknown, index: number): string {
  const name = raw && typeof raw === 'object' && 'name' in raw ? (raw as { name: unknown }).name : undefined;
  return typeof name === 'string' && name.length > 0 ? `device "${name}"` : `device at position ${index + 1}`;
}
