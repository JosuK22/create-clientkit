// Replaced at build time by tsup's `define`. Falls back to a dev sentinel when
// running from source (vitest, tsx) where no define is applied.
declare const __CLI_VERSION__: string | undefined;

export const CLI_VERSION: string =
  typeof __CLI_VERSION__ !== 'undefined' ? __CLI_VERSION__ : '0.0.0-dev';
