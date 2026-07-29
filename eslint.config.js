import pluginJs from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'scripts/**', 'homebridge-ui/public/**', '.remember/**'] },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain ESM JavaScript (package.json sets `"type": "module"` and the file uses
    // import/export), executed by Node inside the Homebridge UI host. Without this it is
    // linted as browser ESM, so every Node global reads as undefined.
    files: ['homebridge-ui/server.js'],
    languageOptions: {
      sourceType: 'module',
      globals: globals.node,
    },
  },
];
