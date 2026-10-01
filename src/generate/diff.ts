/**
 * A line diff, small on purpose.
 *
 * Two texts in, the lines removed and added out, with a little context - enough
 * for a person to see why a file counts as different. Not a patch format, not a
 * merge: nothing applies it, and nothing reads it but a person.
 *
 * Longest-common-subsequence over lines, with a fixed tie-break (prefer
 * removing before adding), so the same two texts always give the same diff.
 * Bounded twice: a file past `MAX_LINES` on either side is not diffed at all,
 * and the rendered diff stops after `MAX_SHOWN` lines with a count of the rest.
 */

/** Past this many lines on either side, a diff is summarised, not computed. */
export const MAX_LINES = 2000;
/** Lines of a rendered diff shown before the rest are counted instead. */
export const MAX_SHOWN = 40;
/** Unchanged lines kept around each change. */
const CONTEXT = 2;

export type DiffLine =
  | { readonly op: ' '; readonly text: string }
  | { readonly op: '-'; readonly text: string }
  | { readonly op: '+'; readonly text: string };

export type TextDiff =
  | {
      readonly status: 'diffed';
      readonly added: number;
      readonly removed: number;
      /** Changed lines with context; `undefined` entries mark skipped unchanged runs. */
      readonly hunks: readonly (DiffLine | undefined)[];
    }
  | {
      readonly status: 'too-large';
      readonly beforeLines: number;
      readonly afterLines: number;
    };

/**
 * Splits text into lines. A final newline ends the last line rather than
 * starting an empty one; a missing final newline is marked on the last line,
 * so "no newline at end of file" shows up as a change.
 */
function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  else lines[lines.length - 1] = `${lines[lines.length - 1]}  (no newline at end of file)`;
  return lines;
}

export function diffText(before: string, after: string): TextDiff {
  const a = linesOf(before);
  const b = linesOf(after);
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return { status: 'too-large', beforeLines: a.length, afterLines: b.length };
  }

  // lcs[i][j]: length of the LCS of a[i..] and b[j..], in one flat array.
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ op: ' ', text: a[i] as string });
      i += 1;
      j += 1;
    } else if (
      i < a.length &&
      (j >= b.length || (lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0))
    ) {
      lines.push({ op: '-', text: a[i] as string });
      i += 1;
    } else {
      lines.push({ op: '+', text: b[j] as string });
      j += 1;
    }
  }

  // Keep changes and the context around them; mark each skipped stretch once.
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.op === ' ') return;
    for (
      let k = Math.max(0, index - CONTEXT);
      k <= Math.min(lines.length - 1, index + CONTEXT);
      k += 1
    ) {
      keep[k] = true;
    }
  });
  const hunks: (DiffLine | undefined)[] = [];
  lines.forEach((line, index) => {
    if (keep[index]) hunks.push(line);
    else if (hunks.length > 0 && hunks[hunks.length - 1] !== undefined) hunks.push(undefined);
  });
  if (hunks[hunks.length - 1] === undefined) hunks.pop();

  return {
    status: 'diffed',
    added: lines.filter((line) => line.op === '+').length,
    removed: lines.filter((line) => line.op === '-').length,
    hunks,
  };
}

/** The diff as indented lines, stopping after `MAX_SHOWN`. */
export function renderDiff(diff: TextDiff, indent = '    '): string[] {
  if (diff.status === 'too-large') {
    return [
      `${indent}diff omitted: ${diff.beforeLines} lines now, ${diff.afterLines} planned - ` +
        `over the ${MAX_LINES}-line preview limit`,
    ];
  }
  const out: string[] = [];
  let shown = 0;
  for (const line of diff.hunks) {
    if (shown === MAX_SHOWN) {
      const rest = diff.hunks
        .slice(MAX_SHOWN)
        .filter((entry) => entry !== undefined && entry.op !== ' ');
      if (rest.length > 0) out.push(`${indent}… ${rest.length} more changed line(s) not shown`);
      break;
    }
    out.push(line === undefined ? `${indent}…` : `${indent}${line.op} ${line.text}`);
    shown += 1;
  }
  return out;
}
