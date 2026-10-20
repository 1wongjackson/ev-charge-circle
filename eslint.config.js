import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['node_modules/', 'data/'] },
  js.configs.recommended,
  { files: ['*.js', 'scripts/**/*.js'], languageOptions: { sourceType: 'module', globals: globals.node } },
  { files: ['public/**/*.js'], languageOptions: { sourceType: 'script', globals: globals.browser } },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-use-before-define': ['error', { functions: false }],
      eqeqeq: ['error', 'smart'],
    },
  },
  prettier,
];
