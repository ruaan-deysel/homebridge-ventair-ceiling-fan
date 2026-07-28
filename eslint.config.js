import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'scripts/**', 'homebridge-ui/public/**', '.remember/**'] },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
];
