import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'prototype/**', 'sandbox/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // Ticket data, provider responses and persisted state are untrusted; every
      // narrowing must stay explicit instead of silently opting out of the type system.
      '@typescript-eslint/no-explicit-any': 'error',
      // Underscore-prefixed bindings document intentionally unused positions.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
    },
  },
);
