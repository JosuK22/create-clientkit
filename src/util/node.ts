/**
 * Node version guard.
 *
 * The hard gate lives in bin/cli.js (plain ES2015, no imports) so an
 * unsupported Node prints a sentence instead of a syntax error. This module is
 * the testable copy used for in-process checks; `test/node.test.ts` asserts the
 * two stay in sync with package.json `engines`.
 */
export const MIN_NODE_VERSION = '20.19.0';

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(version: string): SemverParts | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Returns true when `current` is >= `minimum`. Unparseable input fails open. */
export function satisfiesMinimum(current: string, minimum: string = MIN_NODE_VERSION): boolean {
  const a = parseVersion(current);
  const b = parseVersion(minimum);
  if (!a || !b) return true;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

export function nodeVersionMessage(current: string, minimum: string = MIN_NODE_VERSION): string {
  return `create-clientkit requires Node.js ${minimum} or newer, but found ${current.replace(/^v/, '')}.`;
}
