/**
 * `server.js` is plain JS (it is loaded by the Homebridge UI host straight from the
 * installed package and imports from `dist/`, so it is not part of the TypeScript build).
 * These declarations exist so `test/server.test.ts` is type-checked rather than silently
 * treated as `any`.
 */
export function validateKeysRequest(body: unknown): void;

export function fetchKeys<T>(
  cloud: { getDevice(id: string): Promise<T> },
  ids: string[],
): Promise<{ devices: T[]; failed: { id: string; message: string }[] }>;
