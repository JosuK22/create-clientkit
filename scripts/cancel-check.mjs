#!/usr/bin/env node
/**
 * Verifies that interrupting the CLI at a prompt cancels cleanly:
 *
 *   Ctrl+C -> exit code 130 -> no partial project, no staging directory
 *
 * The CLI only prompts when stdin is a terminal, and a CI runner has none.
 * Spawning it with piped stdio exits 2 ("Cannot prompt because stdin is not an
 * interactive terminal") before any signal arrives - correct behaviour, and
 * what made the first version of this check fail.
 *
 * So a pseudo-terminal is allocated with `script`, present on Linux and macOS,
 * and a literal Ctrl+C byte (0x03) is written to it. That is exactly what a
 * keypress sends.
 *
 * Two portability details, both learned from CI rather than guessed:
 *
 *   1. BSD `script` (macOS) does not propagate the child's exit status - it
 *      returned 1 where GNU `script -e` returned 130. The command therefore
 *      records its own exit code to a file inside the pty session, and that
 *      file is the source of truth on both platforms.
 *
 *   2. The first prompt is "Client / site name", not "Project directory",
 *      because the directory is supplied on the command line and that question
 *      is skipped by design.
 *
 * Windows has neither `script` nor POSIX signal delivery to a child, so it
 * prints the manual procedure instead of pretending to have tested anything.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EXIT_CANCELLED = 130;
const CTRL_C = String.fromCharCode(3); // the byte a Ctrl+C keypress sends

if (process.platform === 'win32') {
  console.log(`
  SKIPPED on Windows: no pty allocation and no POSIX signal delivery to a child.

  Manual procedure (run in a real terminal):

    1. node bin/cli.js my-site
    2. press Ctrl+C at any prompt
    3. expected: "Cancelled." on stderr, no stack trace
    4. expected: echo %ERRORLEVEL% prints 130
    5. expected: no my-site directory and no .my-site.tmp-* directory

  This check runs automatically on the Linux and macOS CI jobs.
`);
  process.exit(0);
}

const cli = path.resolve('bin/cli.js');
const workspace = mkdtempSync(path.join(tmpdir(), 'ck-cancel-'));
const target = path.join(workspace, 'my-site');
const codeFile = path.join(workspace, 'exit-code');
const failures = [];

/** Any of these means the CLI reached an interactive question. */
const PROMPT_LABELS = [
  'Client / site name',
  'Project directory',
  'Production URL',
  'Starting mode',
];
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + String.raw`[[0-9;?]*[a-zA-Z]`, 'g');
const stripAnsi = (text) => text.replace(ANSI, String.fromCharCode(32));

/**
 * Collapses ANSI and all whitespace away before matching.
 *
 * A pty rewrites and wraps as it draws, so a label can arrive split across
 * lines. Comparing without whitespace makes the assertion depend on the text
 * the CLI printed, not on how the terminal happened to lay it out.
 */
const squash = (text) => stripAnsi(text).replace(/\s+/g, '');

/**
 * `stty` sizes the pty from the inside.
 *
 * `script`'s own stdout is a pipe on a CI runner, so it cannot inherit a
 * terminal size and the pty ends up one column wide - which wraps after every
 * single character and stops the prompt ever rendering normally. Setting a
 * realistic size first is what makes this behave like a real terminal.
 *
 * The CLI then records its own exit code, because BSD `script` does not
 * propagate it.
 */
const inner = [
  'stty columns 120 rows 40 2>/dev/null',
  `"${process.execPath}" "${cli}" my-site`,
  `echo $? > "${codeFile}"`,
].join('; ');

/**
 * `script` differs between GNU and BSD:
 *   GNU  script -qec "<command>" /dev/null
 *   BSD  script -q /dev/null <command> [args...]
 */
const args =
  process.platform === 'darwin'
    ? ['-q', '/dev/null', 'sh', '-c', inner]
    : ['-qec', inner, '/dev/null'];

try {
  const child = spawn('script', args, { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });

  let output = '';
  let interrupted = false;

  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    // A short pause lets clack finish putting the terminal into raw mode.
    setTimeout(() => child.stdin.write(CTRL_C), 200);
  };

  const onData = (chunk) => {
    output += String(chunk);
    if (PROMPT_LABELS.some((label) => squash(output).includes(squash(label)))) interrupt();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  // Safety nets: never hang the job.
  const guard = setTimeout(interrupt, 10000);
  const hardStop = setTimeout(() => child.kill('SIGKILL'), 40000);

  await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(guard);
  clearTimeout(hardStop);

  const clean = stripAnsi(output);
  const reached = PROMPT_LABELS.find((label) => squash(output).includes(squash(label)));
  const noTty = /not an interactive terminal/i.test(clean);
  const code = existsSync(codeFile) ? Number(readFileSync(codeFile, 'utf8').trim()) : null;
  const staging = readdirSync(workspace).filter((entry) => entry.includes('.tmp-'));
  const stackTrace = /^\s+at\s/m.test(clean);

  if (noTty) {
    failures.push('`script` did not allocate a pty, so cancellation cannot be verified here');
  } else if (reached === undefined) {
    failures.push(`no prompt was reached; captured output:\n${clean.slice(0, 500)}`);
  }
  if (code === null) {
    failures.push('the CLI never recorded an exit code - it may have been killed');
  } else if (code !== EXIT_CANCELLED) {
    failures.push(`expected exit code ${EXIT_CANCELLED}, got ${code}`);
  }
  if (stackTrace) failures.push('a stack trace was printed on cancellation');
  if (existsSync(target)) failures.push(`a partial project was left at ${target}`);
  if (staging.length > 0) failures.push(`staging directories left behind: ${staging.join(', ')}`);

  console.log(`  pty allocated   : ${noTty ? 'no' : 'yes'}`);
  console.log(`  prompt reached  : ${reached ?? 'none'}`);
  console.log(`  exit code       : ${code ?? 'not recorded'}`);
  console.log(`  stack trace     : ${stackTrace ? 'printed (bad)' : 'none'}`);
  console.log(`  partial project : ${existsSync(target) ? 'left behind (bad)' : 'none'}`);
  console.log(`  staging dirs    : ${staging.length}`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('\ncancellation check FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\ncancellation check passed');
