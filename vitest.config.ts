import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `homebridge-ui/server.js` is plain JS shipped as-is and loaded by Homebridge from the
  // installed package, where only `dist/` exists — its `../dist/...` imports MUST stay as
  // they are or the custom UI breaks for every user. Tests resolve those same specifiers
  // to `src/` instead, so the suite no longer requires a prior `npm run build`.
  resolve: {
    alias: [
      { find: /^\.\.\/dist\/(.*)\.js$/, replacement: fileURLToPath(new URL('./src/', import.meta.url)) + '$1.ts' },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
