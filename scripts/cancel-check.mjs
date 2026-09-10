#!/usr/bin/env node
/**
 * Verifies that interrupting the CLI cancels cleanly:
 *
 *   Ctrl+C -> exit code 130 -> no partial project left behind
 *
 * Windows cannot deliver SIGINT to a child process the way POSIX can - a
 * `process.kill` there terminates the child without running its handlers - so
 * this check runs on Linux and macOS only and prints the manual procedure on
 * Windows rather than pretending to have tested something it has not.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EXIT_CANCELLED = 130;

if (process.platform === 'win32') {
  console.log(`
  SKIPPED on Windows: SIGINT cannot be delivered to a child process here.

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

const workspace = mkdtempSync(path.join(tmpdir(), 'ck-cancel-'));
const target = path.join(workspace, 'my-site');
const failures = [];

try {
  const child = spawn(process.execPath, [path.resolve('bin/cli.js'), 'my-site'], {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  // Give the CLI time to start and reach its first prompt, then interrupt it.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  child.kill('SIGINT');

  const { code, signal } = await new Promise((resolve) => {
    child.on('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });

  if (code !== EXIT_CANCELLED) {
    failures.push(`expected exit code ${EXIT_CANCELLED}, got ${code} (signal ${signal ?? 'none'})`);
  }

  if (/^\s+at\s/m.test(stderr)) {
    failures.push(`a stack trace was printed on cancellation:\n${stderr}`);
  }

  if (existsSync(target)) {
    failures.push(`a partial project was left at ${target}`);
  }

  const staging = readdirSync(workspace).filter((entry) => entry.includes('.tmp-'));
  if (staging.length > 0) {
    failures.push(`staging directories were left behind: ${staging.join(', ')}`);
  }

  console.log(`  exit code       : ${code}`);
  console.log(`  stack trace     : ${/^\s+at\s/m.test(stderr) ? 'printed (bad)' : 'none'}`);
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
