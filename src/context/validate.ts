import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  PACKAGE_MANAGERS,
  TEMPLATE_MODES,
  type PackageManager,
  type TemplateMode,
} from '../types.js';

/** Pure validators return an error sentence, or null when the value is valid. */
export type Validation = string | null;

const MAX_PROJECT_NAME_LENGTH = 214;
/** Conservative ceiling: Windows MAX_PATH is 260 and the generator appends nested paths. */
const MAX_TARGET_PATH_LENGTH = 200;

/** CON, PRN, AUX, NUL, COM0-9, LPT0-9 — illegal as filenames on Windows. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

const RESERVED_NAMES = new Set(['node_modules', 'favicon.ico']);

/** Written as a code-point scan rather than a regex to keep control bytes out of source. */
function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function validateProjectName(name: string): Validation {
  if (name.length === 0) return 'Project name cannot be empty.';
  if (name.trim() !== name) return 'Project name cannot start or end with whitespace.';
  if (name.length > MAX_PROJECT_NAME_LENGTH) {
    return `Project name cannot be longer than ${MAX_PROJECT_NAME_LENGTH} characters.`;
  }
  if (name === '.' || name === '..') return `"${name}" is not a valid project name.`;
  if (/[/\\]/.test(name)) return 'Project name cannot contain path separators.';
  if (name.includes('..')) return 'Project name cannot contain "..".';
  if (/[<>:"|?*]/.test(name)) return 'Project name cannot contain <>:"|?* characters.';
  if (hasControlCharacters(name)) return 'Project name cannot contain control characters.';
  if (/[. ]$/.test(name)) return 'Project name cannot end with a dot or a space.';
  if (WINDOWS_RESERVED.test(name)) return `"${name}" is a reserved name on Windows.`;
  if (RESERVED_NAMES.has(name.toLowerCase())) return `"${name}" is a reserved name.`;
  if (name.startsWith('.') || name.startsWith('_')) {
    return 'Project name cannot start with a dot or an underscore.';
  }
  if (name !== name.toLowerCase()) {
    return `Project name must be lowercase. Try "${sanitizeProjectName(name)}".`;
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    return `Project name may only contain lowercase letters, digits, "-", "_" and ".". Try "${sanitizeProjectName(name)}".`;
  }
  return null;
}

/** Best-effort suggestion, used only inside error messages. */
export function sanitizeProjectName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/-+$/, '')
    .slice(0, MAX_PROJECT_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : 'my-client-site';
}

export function deriveProjectName(dirInput: string, cwd: string): string {
  const normalised = dirInput.replace(/[\\/]+$/, '');
  if (normalised === '' || normalised === '.') return path.basename(cwd);
  return path.basename(normalised);
}

export type TargetDirState = 'missing' | 'empty' | 'non-empty';

export interface TargetDirFs {
  readdirSync: (p: string) => string[];
  statSync: (p: string) => { isDirectory(): boolean };
}

const realFs: TargetDirFs = {
  readdirSync: (p) => readdirSync(p),
  statSync: (p) => statSync(p),
};

/** A lone `.git` does not count as content — pre-created repos are common. */
export function inspectTargetDir(absolutePath: string, fs: TargetDirFs = realFs): TargetDirState {
  let isDirectory: boolean;
  try {
    isDirectory = fs.statSync(absolutePath).isDirectory();
  } catch {
    return 'missing';
  }
  if (!isDirectory) return 'non-empty';
  try {
    const entries = fs.readdirSync(absolutePath).filter((entry) => entry !== '.git');
    return entries.length === 0 ? 'empty' : 'non-empty';
  } catch {
    return 'non-empty';
  }
}

export interface TargetDirCheck {
  readonly absolutePath: string;
  readonly state: TargetDirState;
  readonly error: Validation;
}

export function validateTargetDir(
  dirInput: string,
  options: { cwd: string; home?: string; fs?: TargetDirFs },
): TargetDirCheck {
  const home = options.home ?? homedir();
  const absolutePath = path.resolve(options.cwd, dirInput);
  const state = inspectTargetDir(absolutePath, options.fs);

  const fail = (error: string): TargetDirCheck => ({ absolutePath, state, error });

  if (absolutePath.length > MAX_TARGET_PATH_LENGTH) {
    return fail(
      `Target path is ${absolutePath.length} characters long; keep it under ${MAX_TARGET_PATH_LENGTH} to stay clear of path-length limits.`,
    );
  }
  if (absolutePath === path.parse(absolutePath).root) {
    return fail('Refusing to scaffold into a filesystem root.');
  }
  if (path.resolve(home) === absolutePath) {
    return fail('Refusing to scaffold directly into your home directory.');
  }
  if (state === 'non-empty') {
    return fail(`Directory "${absolutePath}" already exists and is not empty.`);
  }
  return { absolutePath, state, error: null };
}

export function validateSiteName(name: string): Validation {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Site name cannot be empty.';
  if (trimmed.length > 120) return 'Site name cannot be longer than 120 characters.';
  return null;
}

export interface UrlCheck {
  readonly value: string | null;
  readonly error: Validation;
}

/**
 * An omitted URL stays omitted. We never invent a production URL — the template
 * layer decides how absence is represented.
 */
export function validateUrl(input: string | undefined | null): UrlCheck {
  if (input === undefined || input === null) return { value: null, error: null };
  const trimmed = input.trim();
  if (trimmed === '') return { value: null, error: null };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      value: null,
      error: `"${trimmed}" is not a valid URL. Include the scheme, e.g. https://example.com`,
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      value: null,
      error: `Production URL must use http or https, not "${parsed.protocol}".`,
    };
  }
  if (parsed.hostname === '') {
    return { value: null, error: 'Production URL must include a hostname.' };
  }
  if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') {
    return { value: null, error: `"${parsed.hostname}" does not look like a domain name.` };
  }

  // Normalise: drop a bare trailing slash so templates can concatenate paths.
  const normalised =
    parsed.pathname === '/' && parsed.href.endsWith('/') ? parsed.href.slice(0, -1) : parsed.href;
  return { value: normalised, error: null };
}

export function isPackageManagerId(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

export function validatePackageManager(value: string): Validation {
  return isPackageManagerId(value)
    ? null
    : `Unknown package manager "${value}". Supported: ${PACKAGE_MANAGERS.join(', ')}.`;
}

export function isTemplateMode(value: string): value is TemplateMode {
  return (TEMPLATE_MODES as readonly string[]).includes(value);
}

export function validateMode(value: string): Validation {
  return isTemplateMode(value)
    ? null
    : `Unknown mode "${value}". Supported: ${TEMPLATE_MODES.join(', ')}.`;
}

export function validateLocale(value: string): Validation {
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)
    ? null
    : `"${value}" is not a valid BCP-47 locale tag.`;
}
