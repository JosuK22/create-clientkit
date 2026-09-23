/**
 * Every accepted stack, generated into an empty directory and built.
 *
 *     npx vite-node scripts/integration-matrix.mts [--concurrency N] [--only <substring>]
 *
 * Stage 52 proved the resolver can enumerate what ClientKit believes is valid.
 * This proves that what it believes is valid is what it can actually build:
 * generate -> fresh install -> typecheck -> production build, once per accepted
 * configuration, with nothing shared between them but the npm download cache.
 *
 * The set is not written down here. It comes from `enumerateCombinations`,
 * which asks the real resolver and the real compatibility engine, so a matrix
 * that drifts from the product is not possible without a failing unit test in
 * `test/accepted-combinations.test.ts`.
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAdapterRegistry } from '../src/adapters/registry.js';
import { findTemplatesRoot } from '../src/templates/registry.js';
import { enumerateCombinations, type Combination } from '../test/accepted-combinations.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');

/** Directories whose presence would mean the environment was not fresh. */
const STALE = ['node_modules', 'dist', '.next', '.angular', '.cache', '.astro', 'build'];

type Verdict = 'pass' | 'fail' | 'not-applicable' | 'skipped';

interface CaseResult {
  readonly id: string;
  readonly framework: string;
  readonly buildTool: string;
  readonly language: string;
  readonly styling: string;
  readonly uiLibrary: string;
  readonly router: string;
  readonly architecture: string;
  readonly starter: string;
  readonly features: readonly string[];
  generation: Verdict;
  install: Verdict;
  typecheck: Verdict;
  build: Verdict;
  /** Measurement, deliberately separate from identity. */
  timing?: Record<string, number>;
  failure?: { stage: string; classification: string; error: string };
}

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] !== undefined ? (argv[at + 1] as string) : fallback;
};
const CONCURRENCY = Math.max(1, Number(flag('concurrency', '3')));
const ONLY = flag('only', '');
const LOG = flag('log', path.join(tmpdir(), 'ck53-progress.log'));

/**
 * Printed and appended.
 *
 * A run of this length has to be watchable while it runs, and stdout through a
 * pipe is buffered - Stage 52's background runs showed nothing until they
 * finished. The log is a convenience; the artifact is the result.
 */
const say = (line: string): void => {
  console.log(line);
  try {
    appendFileSync(LOG, `${line}\n`, 'utf8');
  } catch {
    /* never let logging fail a run */
  }
};

/**
 * The environment a generated project builds in - this runner's, minus itself.
 *
 * `vite-node` runs with `NODE_ENV=development`, and a child inherits it. That
 * is not a detail: `next build` under a development `NODE_ENV` pulls in React's
 * development build, emits key warnings for the `<html>`/`<head>` tags a
 * framework renders, and fails prerendering `/_global-error` with a null
 * context. It looked exactly like a product defect in Next + MUI, and the same
 * project built cleanly by hand.
 *
 * So the harness's own environment is removed rather than overridden: deleting
 * `NODE_ENV` lets each tool choose its own default - `npm install` still
 * installs devDependencies, `next build` and `vite build` still build for
 * production - where pinning it to `production` would have skipped the very
 * devDependencies the build needs.
 */
const CHILD_ENV: NodeJS.ProcessEnv = (() => {
  const inherited = { ...process.env };
  delete inherited.NODE_ENV;
  for (const key of Object.keys(inherited)) {
    if (key.startsWith('VITE_') || key === 'VITEST' || key === 'VITEST_MODE') delete inherited[key];
  }
  return inherited;
})();

/** One child process, with its own stdio captured and a hard deadline. */
function run(
  command: string,
  args: readonly string[],
  cwd: string,
  timeout: number,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: CHILD_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
      // npm is a shell script on Windows; node is not, and quoting its own path
      // through a shell is what broke the Stage 52 tarball harness.
      shell: command !== process.execPath,
      windowsHide: true,
    });

    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 200_000) output = output.slice(-200_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      // Kill the tree, not just the shell, so nothing is left serving.
      child.kill('SIGKILL');
      resolve({ code: -1, output: `${output}\n[timed out after ${timeout}ms]` });
    }, timeout);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${output}\n${String(error)}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });
}

const flagsFor = (combination: Combination): readonly string[] => {
  const flags = [
    '--framework',
    combination.framework,
    '--styling',
    combination.styling,
    '--ui-library',
    combination.uiLibrary,
    '--router',
    combination.router,
    '--language',
    combination.language,
    '--mode',
    combination.starter,
    '--name',
    'Acme Ltd',
    '--url',
    'https://acme.example',
    '--no-git',
    '--no-install',
    '-y',
  ];
  if (combination.features.length > 0) flags.push('--features', combination.features.join(','));
  return flags;
};

/**
 * Which script validates types for this project, read from what it ships.
 *
 * Never guessed: Stage 52 assumed `typecheck` everywhere and silently recorded
 * a failure on Astro, which calls it `check`. A project with neither gets
 * `not-applicable` and the reason is reported, rather than a green tick for a
 * step that did not run.
 */
function typecheckScript(target: string): string | undefined {
  const scripts = (
    JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    }
  ).scripts;
  for (const candidate of ['typecheck', 'check']) {
    if (scripts?.[candidate] !== undefined) return candidate;
  }
  return undefined;
}

/** Workspaces Windows would not let go of on the first attempt. */
const stubborn: string[] = [];

/**
 * Removes a finished workspace, and never fails the run for it.
 *
 * The first full matrix attempt died three cases in with `EBUSY: resource busy
 * or locked` while removing a project whose build had just exited - a Windows
 * handle that outlives the process that held it, which no amount of correct
 * sequencing avoids. Retrying handles almost all of them; anything still locked
 * is remembered, swept once at the end, and reported rather than thrown, so a
 * cleanup detail cannot abort a forty-minute measurement.
 */
function discard(workspace: string): void {
  try {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch {
    stubborn.push(workspace);
  }
}

async function runCase(combination: Combination): Promise<CaseResult> {
  const result: CaseResult = {
    ...combination,
    generation: 'skipped',
    install: 'skipped',
    typecheck: 'skipped',
    build: 'skipped',
    timing: {},
  };

  const workspace = mkdtempSync(path.join(tmpdir(), 'ck53-'));
  const target = path.join(workspace, 'acme-site');
  const since = () => {
    const started = Date.now();
    return () => Date.now() - started;
  };

  try {
    // --- generate ----------------------------------------------------------
    let elapsed = since();
    const generated = await run(
      process.execPath,
      [CLI, target, ...flagsFor(combination)],
      workspace,
      120_000,
    );
    result.timing!.generate = elapsed();
    if (generated.code !== 0) {
      result.generation = 'fail';
      result.failure = {
        stage: 'GENERATION',
        classification: 'PRODUCT',
        error: tail(generated.output),
      };
      return result;
    }
    result.generation = 'pass';

    // --- the environment really is fresh ------------------------------------
    const stale = STALE.filter((entry) => existsSync(path.join(target, entry)));
    if (stale.length > 0) {
      result.install = 'fail';
      result.failure = {
        stage: 'INSTALL',
        classification: 'HARNESS',
        error: `not fresh: ${stale.join(', ')}`,
      };
      return result;
    }

    // --- install ------------------------------------------------------------
    elapsed = since();
    const installed = await run('npm', ['install', '--no-audit', '--no-fund'], target, 900_000);
    result.timing!.install = elapsed();
    if (installed.code !== 0) {
      result.install = 'fail';
      result.failure = {
        stage: 'INSTALL',
        classification: 'UNCLASSIFIED',
        error: tail(installed.output),
      };
      return result;
    }
    result.install = 'pass';

    // --- typecheck ----------------------------------------------------------
    const script = typecheckScript(target);
    if (script === undefined) {
      result.typecheck = 'not-applicable';
    } else {
      elapsed = since();
      const checked = await run('npm', ['run', script], target, 900_000);
      result.timing![`typecheck:${script}`] = elapsed();
      if (checked.code !== 0) {
        result.typecheck = 'fail';
        result.failure = {
          stage: 'TYPECHECK',
          classification: 'UNCLASSIFIED',
          error: tail(checked.output),
        };
        return result;
      }
      result.typecheck = 'pass';
    }

    // --- production build ---------------------------------------------------
    elapsed = since();
    const built = await run('npm', ['run', 'build'], target, 1_200_000);
    result.timing!.build = elapsed();
    if (built.code !== 0) {
      result.build = 'fail';
      result.failure = {
        stage: 'BUILD',
        classification: 'UNCLASSIFIED',
        error: tail(built.output),
      };
      return result;
    }
    result.build = 'pass';
    return result;
  } finally {
    // Always, even on a throw: 104 installed dependency trees is tens of
    // gigabytes, and leaving them behind is its own kind of failure.
    discard(workspace);
  }
}

function tail(output: string): string {
  return (
    output
      // eslint-disable-next-line no-control-regex -- stripping ANSI colour is the point
      .replace(/\u001b\[[0-9;]*m/g, '')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(-12)
      .join(' | ')
      .slice(-900)
  );
}

/** A fixed pool: bounded, and every worker owns its own temporary directory. */
async function pool(cases: readonly Combination[], width: number): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= cases.length) return;
      const combination = cases[index] as Combination;
      // A worker must survive its case. Anything escaping `runCase` is the
      // harness misbehaving, and it is recorded as such rather than taking the
      // other workers' results down with it.
      const result = await runCase(combination).catch((error: unknown): CaseResult => ({
        ...combination,
        generation: 'skipped',
        install: 'skipped',
        typecheck: 'skipped',
        build: 'fail',
        failure: { stage: 'HARNESS', classification: 'HARNESS', error: String(error) },
      }));
      results.push(result);
      done += 1;
      const verdict = result.build === 'pass' ? 'ok  ' : `FAIL(${result.failure?.stage ?? '?'})`;
      say(
        `[${String(done).padStart(3)}/${cases.length}] ${verdict} ${result.id}` +
          (result.typecheck === 'not-applicable' ? '  (no typecheck script)' : ''),
      );
      if (result.failure) say(`        ${result.failure.error.slice(0, 300)}`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(width, cases.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------

const adapters = createAdapterRegistry(findTemplatesRoot(path.join(ROOT, 'src')));
const enumeration = enumerateCombinations(adapters);
const cases = enumeration.accepted.filter((entry) => ONLY === '' || entry.id.includes(ONLY));

console.log(
  `accepted: ${enumeration.accepted.length} of ${enumeration.total} enumerated` +
    (ONLY ? `  (running ${cases.length} matching "${ONLY}")` : '') +
    `  concurrency=${CONCURRENCY}`,
);
console.log(`node ${process.version}  package manager: npm\n`);

const started = Date.now();
const unordered = await pool(cases, CONCURRENCY);

// Report order is the declared one, never the order work finished in.
const byId = new Map(unordered.map((entry) => [entry.id, entry]));
const results = cases.map((entry) => byId.get(entry.id) as CaseResult);

const passed = results.filter((entry) => entry.build === 'pass');
const failed = results.filter((entry) => entry.build !== 'pass');

console.log(`\n${'='.repeat(70)}`);
console.log(
  `generated : ${results.filter((r) => r.generation === 'pass').length}/${results.length}`,
);
console.log(`installed : ${results.filter((r) => r.install === 'pass').length}/${results.length}`);
console.log(
  `typecheck : ${results.filter((r) => r.typecheck === 'pass').length} pass, ` +
    `${results.filter((r) => r.typecheck === 'not-applicable').length} n/a, ` +
    `${results.filter((r) => r.typecheck === 'fail').length} fail`,
);
console.log(`built     : ${passed.length}/${results.length}`);
console.log(`wall clock: ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);

for (const failure of failed) {
  console.log(`\nFAIL ${failure.id}`);
  console.log(`  stage: ${failure.failure?.stage}  class: ${failure.failure?.classification}`);
  console.log(`  ${failure.failure?.error}`);
}

/*
 * The artifact carries identity and verdicts only. Timings are measurement and
 * live beside it, never inside the thing that is supposed to be deterministic,
 * and no absolute path appears in either.
 */
const artifact = results.map((result) => ({
  id: result.id,
  framework: result.framework,
  buildTool: result.buildTool,
  language: result.language,
  styling: result.styling,
  uiLibrary: result.uiLibrary,
  router: result.router,
  architecture: result.architecture,
  starter: result.starter,
  features: result.features,
  generation: result.generation,
  install: result.install,
  typecheck: result.typecheck,
  build: result.build,
  ...(result.failure
    ? {
        failure: {
          stage: result.failure.stage,
          classification: result.failure.classification,
        },
      }
    : {}),
}));
writeFileSync(
  path.join(ROOT, 'docs', 'integration-matrix.json'),
  `${JSON.stringify(artifact, null, 2)}\n`,
  'utf8',
);
writeFileSync(
  path.join(tmpdir(), 'ck53-timings.json'),
  `${JSON.stringify(
    results.map(({ id, timing }) => ({ id, timing })),
    null,
    2,
  )}\n`,
  'utf8',
);
// One last sweep for anything Windows was still holding when its case ended.
for (const workspace of [...stubborn]) {
  try {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    stubborn.splice(stubborn.indexOf(workspace), 1);
  } catch {
    /* reported below rather than hidden */
  }
}
if (stubborn.length > 0) {
  console.log(`\n${stubborn.length} temporary workspace(s) could not be removed:`);
  for (const workspace of stubborn) console.log(`  ${path.basename(workspace)}`);
}

console.log('\nwrote docs/integration-matrix.json');

process.exit(failed.length === 0 ? 0 : 1);
