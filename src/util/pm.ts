import { PACKAGE_MANAGERS, type PackageManager } from '../types.js';

export function isPackageManager(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

/**
 * Detect the package manager from `npm_config_user_agent`, which every
 * supported client sets when it spawns a script.
 *
 *   npm/10.9.2 node/v22.15.0 win32 x64 workspaces/false
 *   pnpm/9.1.0 npm/? node/v22.15.0 win32 x64
 *   yarn/4.1.0 npm/? node/v22.15.0 win32 x64
 *   bun/1.1.8 npm/? node/v22.15.0 win32 x64
 *
 * Returns null when detection fails; callers fall back to the default. The user
 * is never asked which package manager they use.
 */
export function detectPackageManager(userAgent: string | undefined): PackageManager | null {
  if (!userAgent) return null;
  const first = userAgent.trim().split(/\s+/)[0];
  if (!first) return null;
  const name = first.split('/')[0]?.toLowerCase();
  if (!name) return null;
  return isPackageManager(name) ? name : null;
}
