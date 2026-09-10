import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Deliberately small: the base JavaScript rules, typescript-eslint's
 * recommended set, and a handful of project rules that encode decisions made
 * in earlier milestones. No plugin ecosystem - `tsc --noEmit` already carries
 * the heavy type checking, so ESLint only needs to catch what types cannot.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      // Inert template source. It imports Astro types that are not installed
      // in this repo, and it is verified by generating and building a real
      // project (`npm run smoke`) rather than by linting it here.
      'templates/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    rules: {
      // The Logger is the only thing allowed to write to stdout/stderr, so a
      // stray console call is a layering mistake rather than a style nit.
      'no-console': 'error',

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Empty catch blocks are used deliberately for "this is allowed to fail".
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  {
    // Plain JavaScript running in Node: the bin launcher and the operator
    // scripts. tsc covers the TypeScript sources, so only these need globals
    // declared for no-undef.
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { globals: globals.node },
  },

  {
    // Scripts are operator tooling: printing is their job. The audit scripts
    // also pass callbacks to page.evaluate, which run in the browser, so both
    // global sets apply.
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-console': 'off' },
  },

  {
    files: ['test/**/*.ts'],
    rules: {
      // Tests deliberately poke at malformed input.
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
);
