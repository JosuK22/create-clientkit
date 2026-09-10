#!/usr/bin/env node
/**
 * Verifies that interrupting the CLI at a prompt cancels cleanly:
 *
 *   Ctrl+C -> exit code 130 -> no partial project, no staging directory
 *
 * The CLI only prompts when stdin is a terminal, and a CI runner has none.
 * Spawning it with piped stdio therefore exits 2 ("Cannot prompt because stdin
 * is not an interactive terminal") long before any signal arrives - which is
 * correct behaviour, and what made the first version of this check fail.
 *
 * So a pseudo-terminal is allocated with `script`, present on both Linux and
 * macOS runners, and a literal Ctrl+C byte (0x03) is written to it. That is
 * exactly what a keypress does, rather than an approximation of it.
 *
 * Windows has neither `script` nor POSIX signal delivery to a child, so it
 * prints the manual procedure instead of pretending to have tested anything.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
const failures = [];

/**
 * `script` differs between GNU and BSD:
 *   GNU  script -qec "<command>" /dev/null
 *   BSD  script -q /dev/null <command> [args...]
 */
const command = `${process.execPath} ${cli} my-site`;
const [bin, args] =
  process.platform === 'darwin'
    ? ['script', ['-q', '/dev/null', process.execPath, cli, 'my-site']]
    : ['script', ['-qec', command, '/dev/null']];

try {
  const child = spawn(bin, args, { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });

  let output = '';
  let interrupted = false;

  const onData = (chunk) => {
    output += String(chunk);
    // Interrupt as soon as the first question is on screen, rather than after
    // a fixed delay that might fire before or long after it appears.
    if (!interrupted && /Project directory/i.test(output)) {
      interrupted = true;
      setTimeout(() => child.stdin.write(CTRL_C), 150);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  // Safety net: never hang the job if the prompt never appears.
  const guard = setTimeout(() => {
    if (!interrupted) {
      interrupted = true;
      child.stdin.write(CTRL_C);
    }
  }, 8000);
  const hardStop = setTimeout(() => child.kill('SIGKILL'), 30000);

  const { code, signal } = await new Promise((resolve) => {
    child.on('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  clearTimeout(guard);
  clearTimeout(hardStop);

  const sawPrompt = /Project directory/i.test(output);
  const noTty = /not an interactive terminal/i.test(output);

  if (noTty) {
    failures.push(
      'the CLI did not see a terminal, so `script` did not allocate a pty. ' +
        'This check cannot verify cancellation without one.',
    );
  } else if (!sawPrompt) {
    failures.push(`the prompt never appeared; captured output:\n${output.slice(0, 600)}`);
  }

  if (code !== EXIT_CANCELLED) {
    failures.push(`expected exit code ${EXIT_CANCELLED}, got ${code} (signal ${signal ?? 'none'})`);
  }
  // A stack trace would mean the cancellation escaped the error boundary.
  if (/^\s+at\s/m.test(output)) failures.push('a stack trace was printed on cancellation');
  if (existsSync(target)) failures.push(`a partial project was left at ${target}`);

  const staging = readdirSync(workspace).filter((entry) => entry.includes('.tmp-'));
  if (staging.length > 0) failures.push(`staging directories left behind: ${staging.join(', ')}`);

  console.log(`  pty allocated   : ${noTty ? 'no' : 'yes'}`);
  console.log(`  prompt reached  : ${sawPrompt ? 'yes' : 'no'}`);
  console.log(`  exit code       : ${code}`);
  console.log(`  stack trace     : ${/^\s+at\s/m.test(output) ? 'printed (bad)' : 'none'}`);
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
