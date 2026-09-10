import { CliError } from '../errors.js';

/**
 * Deep-merges JSON layers.
 *
 * Objects merge key by key. Arrays concatenate and then de-duplicate, so a mode
 * layer can add a script or a keyword without clobbering the base list. Scalars
 * are replaced by the later layer.
 */
export function deepMergeJson(base: unknown, overlay: unknown, atPath = ''): unknown {
  if (Array.isArray(base) && Array.isArray(overlay)) {
    return dedupeArray([...base, ...overlay]);
  }
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
      result[key] = key in base ? deepMergeJson(base[key], value, joinPath(atPath, key)) : value;
    }
    return result;
  }
  if (isPlainObject(base) !== isPlainObject(overlay) && base !== undefined) {
    // A type change between layers is almost always a template bug worth surfacing.
    if (Array.isArray(base) !== Array.isArray(overlay)) {
      throw new CliError(
        `Template layers disagree about the shape of "${atPath || '<root>'}" in a merged JSON file.`,
        { hint: 'One layer supplies an object or array where another supplies a scalar.' },
      );
    }
  }
  return overlay;
}

/** Primitives de-duplicate by value; objects are compared structurally. */
function dedupeArray(items: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const item of items) {
    const key =
      typeof item === 'object' && item !== null
        ? JSON.stringify(item)
        : `${typeof item}:${String(item)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinPath(base: string, key: string): string {
  return base === '' ? key : `${base}.${key}`;
}

export function parseJsonLayer(content: string, sourceLabel: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new CliError(
      `Template file ${sourceLabel} is not valid JSON: ${(error as Error).message}`,
    );
  }
}

/** Stable, human-editable output: 2-space indent and a trailing newline. */
export function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
