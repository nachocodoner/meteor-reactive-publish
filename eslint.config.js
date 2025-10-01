// eslint.config.js
import globals from 'globals';
import js from '@eslint/js';
import ts from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import react from 'eslint-plugin-react';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

export default [
  // Ignores
  {
    ignores: [
      'node_modules/',
      '**/node_modules/',
      'dist/',
      'build/',
      'coverage/',
      '.vscode/',
      '.env',
      '**/package-lock.json',
      '**/yarn.lock',
      '*.min.js',
      '**/.meteor/local/',
      '.npm/',
      '.idea/',
      '.husky/',
    ],
  },

  // JavaScript base rules
  js.configs.recommended,

  // TypeScript rules
  {
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        env: {
          browser: true,
          jest: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.jest,

        // Define Meteor global explicitly
        Meteor: 'readonly',
        Package: 'readonly',
        testAsyncMulti: 'readonly',
        Npm: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': ts },
    rules: {
      ...ts.configs.recommended.rules,
    },
  },

  // React rules
  {
    plugins: { react },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...react.configs.recommended.rules,
    },
  },

  // JSX Accessibility rules
  {
    plugins: { 'jsx-a11y': jsxA11y },
    rules: {
      ...jsxA11y.configs.recommended.rules,
    },
  },

  // Prettier rules
  prettierConfig,
  {
    plugins: { prettier },
    rules: {
      'prettier/prettier': 'error',
    },
  },

  // Custom rules
  {
    rules: {
      'jsx-a11y/anchor-is-valid': 'warn',
      'jsx-a11y/no-autofocus': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-this-alias': 'off',
    },
  },
];
