/**
 * The representative runtime matrix: generated projects, actually served.
 *
 *     npx vite-node scripts/runtime-matrix.mts [--only <substring>] [--repeat]
 *
 * Stage 53 proved every accepted configuration builds. A build is not a
 * behaviour, so this starts each project's own production server - `astro
 * preview`, `next start`, `vite preview`, not a static server of our own, since
 * the 404 semantics under test belong to the framework - fetches real URLs, and
 * drives a real browser where the DOM after hydration is the only place the
 * answer lives.
 *
 * Which projects, and why each one, is `test/runtime-cases.ts`: a greedy cover
 * over the accepted set, so the list cannot drift from what the product
 * supports.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAdapterRegistry } from '../src/adapters/registry.js';
import { findTemplatesRoot } from '../src/templates/registry.js';
import { runtimeMatrix, type Contract, type RuntimeCase } from '../test/runtime-cases.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const SITE_URL = 'https://acme.example';

const argv = process.argv.slice(2);
const flagValue = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] !== undefined ? (argv[at + 1] as string) : fallback;
};
const ONLY = flagValue('only', '');
const REPEAT = argv.includes('--repeat');

/** `vite-node` runs at NODE_ENV=development; a production build must not. */
const CHILD_ENV: NodeJS.ProcessEnv = (() => {
  const env = { ...process.env };
  delete env.NODE_ENV;
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITE_') || key === 'VITEST') delete env[key];
  }
  return env;
})();

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

function once(
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
      shell: command !== process.execPath,
      windowsHide: true,
    });
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 120_000) output = output.slice(-120_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      killTree(child);
      resolve({ code: -1, output: `${output}\n[timed out]` });
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

/**
 * Ends a server and everything it started.
 *
 * `child.kill()` is not enough on Windows: `npm run start` is a shell that
 * spawns node, and killing the shell orphans the server - which is exactly the
 * leak Stage 51 spent a measurement chasing, and Stage 53 was told not to
 * repeat. The process *tree* is killed by id, and the caller then waits for the
 * port to actually come free before moving on.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * Kills anything still running out of one workspace, by that workspace's path.
 *
 * Killing the tree by process id is not sufficient here, and this stage caught
 * it doing the wrong thing: `npm run start` is a shell that launches node and
 * then exits, so by the time the server matters its parent is gone and
 * `taskkill /T` has no tree left to walk. A part-way run had three `next` and
 * `vite` servers still listening, still holding their directories open - the
 * exact leak Stage 51 hit and this stage was told to prevent.
 *
 * The workspace path is what makes this precise rather than a blunt "kill every
 * node": only a process whose own command line names this temporary directory
 * can be one this case started, so nothing else on the machine is at risk.
 */
function killByWorkspace(workspace: string): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve();
  const script =
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${path.basename(workspace)}*' } | ` +
    `ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`;
  return new Promise((resolve) => {
    const sweep = spawn('powershell', ['-NoProfile', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
    });
    sweep.on('close', () => resolve());
    sweep.on('error', () => resolve());
    setTimeout(() => resolve(), 15_000);
  });
}

/** A port the OS says is free, rather than one we hope is. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function reachable(origin: string): Promise<boolean> {
  try {
    await fetch(origin, { redirect: 'manual' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts a server, runs the assertions, and always stops it again.
 *
 * The `finally` is the point: a thrown assertion, a timeout or a failed
 * readiness check all end with the tree killed and the port released, so no
 * case can leave a server behind for the next one to collide with.
 */
async function withServer<T>(
  target: string,
  script: readonly string[],
  fn: (origin: string, port: number) => Promise<T>,
): Promise<T> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn('npm', [...script, '--', ...portArgs(script[1] as string, port)], {
    cwd: target,
    env: CHILD_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (c: Buffer) => (log += c.toString()));
  child.stderr.on('data', (c: Buffer) => (log += c.toString()));

  try {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (await reachable(origin)) return await fn(origin, port);
      if (child.exitCode !== null) {
        throw new Error(`server exited early (${child.exitCode}): ${log.slice(-500)}`);
      }
      await sleep(500);
    }
    throw new Error(`server never became reachable on ${origin}: ${log.slice(-500)}`);
  } finally {
    killTree(child);
    const freeBy = Date.now() + 20_000;
    while (Date.now() < freeBy && (await reachable(origin))) await sleep(250);
  }
}

/** Each framework's own way of being told which port to listen on. */
function portArgs(script: string, port: number): string[] {
  if (script === 'start') return ['--port', String(port), '--hostname', '127.0.0.1'];
  return ['--port', String(port), '--host', '127.0.0.1', '--strictPort'];
}

const serveScript = (framework: string): string[] =>
  framework === 'nextjs' ? ['run', 'start'] : ['run', 'preview'];

// ---------------------------------------------------------------------------
// Added routes
// ---------------------------------------------------------------------------

const ASTRO_CONTACT = `---
import BaseLayout from '../layouts/BaseLayout.astro';
---

<BaseLayout title="Contact" description="Talk to us." measure="narrow">
  <div class="container-page">
    <h1 class="page-title">Contact</h1>
    <p class="lead">A page added by hand after generation.</p>
  </div>
</BaseLayout>
`;

const NEXT_CONTACT = `export default function Contact() {
  return (
    <main className="container-page">
      <h1 className="page-title">Contact</h1>
      <p className="lead">A page added by hand after generation.</p>
    </main>
  );
}
`;

/** Writes the routes a developer would add later, in the framework's own shape. */
function addRoutes(target: string, framework: string, routes: readonly string[]): void {
  for (const route of routes) {
    const name = route.replace(/^\//, '');
    if (framework === 'astro') {
      writeFileSync(path.join(target, 'src', 'pages', `${name}.astro`), ASTRO_CONTACT, 'utf8');
    } else if (framework === 'nextjs') {
      const dir = path.join(target, 'app', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'page.tsx'), NEXT_CONTACT, 'utf8');
    }
  }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

interface Check {
  readonly contract: Contract | 'harness';
  readonly what: string;
  readonly expected: string;
  readonly actual: string;
  readonly ok: boolean;
}

const canonicalsIn = (html: string): string[] =>
  [...html.matchAll(/<link[^>]+rel="canonical"[^>]*>/g)].map(
    (match) => /href="([^"]*)"/.exec(match[0])?.[1] ?? '',
  );

const jsonLdCount = (html: string): number =>
  [...html.matchAll(/<script[^>]+type="application\/ld\+json"/g)].length;

export interface CaseResult {
  readonly id: string;
  readonly framework: string;
  readonly configuration: Record<string, unknown>;
  readonly routes: { path: string; status: number; contentType: string }[];
  readonly http: Record<string, string>;
  readonly browser: Record<string, string>;
  readonly features: Record<string, string>;
  readonly contracts: readonly string[];
  readonly checks: Check[];
  result: 'pass' | 'fail';
  failure?: string;
}

/**
 * Browser noise that is not a defect.
 *
 * A generated project ships `favicon.svg` and no `favicon.ico`; a browser asks
 * for the `.ico` anyway and logs a 404. That behaviour predates this stage and
 * is a known, accepted property of the template rather than something this
 * matrix introduced, so it is named here and excluded - narrowly, by URL, so a
 * real failed asset still fails.
 */
const IGNORABLE = [/favicon\.ico/i];
const ignorable = (text: string): boolean => IGNORABLE.some((pattern) => pattern.test(text));

/** One served project, examined over HTTP and then in a real browser. */
async function examine(
  runtimeCase: RuntimeCase,
  origin: string,
  port: number,
): Promise<{ checks: Check[]; result: CaseResult }> {
  const { combination, contracts, url, addedRoutes } = runtimeCase;
  const framework = combination.framework;
  const checks: Check[] = [];
  const routes: CaseResult['routes'] = [];
  const http: Record<string, string> = { port: String(port) };
  const browser: Record<string, string> = {};
  const features: Record<string, string> = {};

  const record = (
    contract: Contract | 'harness',
    what: string,
    expected: string,
    actual: string,
    ok: boolean,
  ): void => {
    checks.push({ contract, what, expected, actual, ok });
  };

  const get = async (route: string): Promise<{ status: number; body: string; type: string }> => {
    const response = await fetch(`${origin}${route}`, { redirect: 'manual' });
    const body = await response.text();
    const type = response.headers.get('content-type') ?? '';
    routes.push({ path: route, status: response.status, contentType: type.split(';')[0] ?? '' });
    return { status: response.status, body, type };
  };

  // --- home -----------------------------------------------------------------
  const home = await get('/');
  record(
    'home-200',
    'GET /',
    '200 text/html',
    `${home.status} ${home.type.split(';')[0]}`,
    home.status === 200 && home.type.includes('text/html'),
  );
  http['/'] = String(home.status);

  // --- a route added by hand after generation --------------------------------
  if (addedRoutes.length > 0) {
    const added = await get(addedRoutes[0] as string);
    record(
      'added-route-200',
      `GET ${addedRoutes[0]}`,
      '200',
      String(added.status),
      added.status === 200,
    );
    http[addedRoutes[0] as string] = String(added.status);
    if (contracts.includes('canonical-added-route')) {
      const found = canonicalsIn(added.body);
      /*
       * With or without the trailing slash. Astro builds a page to
       * `contact/index.html`, so the address of that page genuinely is
       * `/contact/` and its canonical says so; Next serves `/contact`. Both are
       * the same promise - one canonical, absolute, naming this route - and
       * insisting on one spelling would be asserting a build format rather than
       * a contract.
       */
      const acceptable = [`${SITE_URL}${addedRoutes[0]}`, `${SITE_URL}${addedRoutes[0]}/`];
      record(
        'canonical-added-route',
        `canonical on ${addedRoutes[0]}`,
        `exactly one of ${acceptable.join(' or ')}`,
        JSON.stringify(found),
        found.length === 1 && acceptable.includes(found[0] as string),
      );
    }
  }

  // --- not found ------------------------------------------------------------
  if (contracts.includes('not-found-404')) {
    const unmatched = framework === 'astro' ? ['/nope'] : ['/nope', '/contact/missing', '/a/b/c'];
    for (const route of unmatched) {
      const missing = await get(route);
      record(
        'not-found-404',
        `GET ${route}`,
        '404',
        String(missing.status),
        missing.status === 404,
      );
      http[route] = String(missing.status);

      if (contracts.includes('canonical-absent-on-404')) {
        const found = canonicalsIn(missing.body);
        record(
          'canonical-absent-on-404',
          `canonical on ${route}`,
          'none',
          JSON.stringify(found),
          found.length === 0,
        );
        // The specific leak Stage 51 closed.
        record(
          'canonical-absent-on-404',
          `no /_not-found canonical on ${route}`,
          'absent',
          missing.body.includes('_not-found') ? 'present' : 'absent',
          !/rel="canonical"[^>]*_not-found/.test(missing.body),
        );
      }
      if (contracts.includes('json-ld-absent-on-404')) {
        record(
          'json-ld-absent-on-404',
          `JSON-LD on ${route}`,
          '0 blocks',
          String(jsonLdCount(missing.body)),
          jsonLdCount(missing.body) === 0,
        );
      }
    }
    features['not-found'] = 'HTTP 404 from the framework router';
  }

  // Astro's own 404 route, which is a page rather than only a status.
  if (framework === 'astro' && contracts.includes('not-found-404')) {
    const page = await get('/404');
    record(
      'not-found-404',
      'GET /404',
      'served',
      String(page.status),
      page.status === 404 || page.status === 200,
    );
    record(
      'not-found-404',
      '/404 renders the not-found page',
      'contains the heading',
      page.body.includes("This page doesn't exist.") ? 'present' : 'absent',
      page.body.includes("This page doesn't exist."),
    );
    if (contracts.includes('canonical-absent-on-404')) {
      const found = canonicalsIn(page.body);
      record(
        'canonical-absent-on-404',
        'canonical on /404',
        'none',
        JSON.stringify(found),
        found.length === 0,
      );
    }
  }

  // --- canonical on the home page -------------------------------------------
  if (contracts.includes('canonical-present')) {
    const found = canonicalsIn(home.body);
    const acceptable = [SITE_URL, `${SITE_URL}/`];
    record(
      'canonical-present',
      'canonical on /',
      `exactly one of ${acceptable.join(' or ')}`,
      JSON.stringify(found),
      found.length === 1 && acceptable.includes(found[0] as string),
    );
    features['seo'] = `canonical ${found[0] ?? '(none)'}`;
  }
  if (contracts.includes('canonical-absent-url-less')) {
    const everywhere = [home.body];
    if (addedRoutes.length > 0) everywhere.push((await get(addedRoutes[0] as string)).body);
    const found = everywhere.flatMap(canonicalsIn);
    record(
      'canonical-absent-url-less',
      'canonical anywhere with no configured URL',
      'none',
      JSON.stringify(found),
      found.length === 0,
    );
    const fabricated = everywhere.some((body) =>
      /rel="canonical"[^>]*(localhost|127\.0\.0\.1)/.test(body),
    );
    record(
      'canonical-absent-url-less',
      'no fabricated localhost canonical',
      'absent',
      fabricated ? 'present' : 'absent',
      !fabricated,
    );
    features['seo'] = 'no canonical, no invented origin';
  }

  // --- structured data ------------------------------------------------------
  if (contracts.includes('json-ld-present')) {
    const count = jsonLdCount(home.body);
    record('json-ld-present', 'JSON-LD on /', 'exactly one block', String(count), count === 1);
    record(
      'json-ld-present',
      'JSON-LD describes an Organization',
      'Organization',
      /"@type"\s*:\s*"Organization"/.test(home.body) ? 'Organization' : 'absent',
      /"@type"\s*:\s*"Organization"/.test(home.body),
    );
    features['structured-data'] = `${count} Organization block`;
  }

  // --- stylesheet -----------------------------------------------------------
  if (contracts.includes('stylesheet-loads')) {
    const href = /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/.exec(home.body)?.[1];
    if (href === undefined) {
      // Vite inlines small stylesheets into the bundle for some builds; a style
      // element is the same promise kept a different way.
      const inline = /<style[^>]*>[\s\S]{40,}?<\/style>/.test(home.body);
      record(
        'stylesheet-loads',
        'stylesheet present on /',
        'linked or inlined',
        inline ? 'inlined' : 'absent',
        inline,
      );
    } else {
      const asset = await fetch(new URL(href, origin));
      record(
        'stylesheet-loads',
        `GET ${href}`,
        '200 css',
        `${asset.status} ${asset.headers.get('content-type') ?? ''}`,
        asset.status === 200,
      );
    }
  }

  return {
    checks,
    result: {
      id: runtimeCase.id,
      framework,
      configuration: {
        framework,
        buildTool: combination.buildTool,
        language: combination.language,
        styling: combination.styling,
        uiLibrary: combination.uiLibrary,
        router: combination.router,
        architecture: combination.architecture,
        starter: combination.starter,
        features: combination.features,
        url,
      },
      routes,
      http,
      browser,
      features,
      contracts,
      checks,
      result: 'pass',
    },
  };
}

/**
 * The half of the contract that only exists once JavaScript has run.
 *
 * Fetching HTML shows what the server sent. It cannot show that React mounted,
 * that a client-side router matched an address the server never saw, that MUI's
 * provider initialised, or that hydration agreed with the markup - and those are
 * exactly the promises Stages 26, 27 and 51 made. So a real browser loads the
 * page, and console errors, page errors and failed requests are collected while
 * it does.
 */
async function inBrowser(
  runtimeCase: RuntimeCase,
  origin: string,
  record: (
    c: Contract | 'harness',
    what: string,
    expected: string,
    actual: string,
    ok: boolean,
  ) => void,
  browser: Record<string, string>,
): Promise<void> {
  const { combination, contracts } = runtimeCase;
  const puppeteer = (await import('puppeteer')).default;
  const instance = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await instance.newPage();
    const errors: string[] = [];
    const failed: string[] = [];
    /*
     * Filtered by URL, never by message text.
     *
     * "Failed to load resource: the server responded with a status of 404"
     * names nothing, so deciding from the text alone would either hide a real
     * missing asset or fail the stage on the favicon every template has always
     * had. The resource's own address is the only thing that distinguishes
     * them, and `message.location()` carries it.
     */
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const from = message.location()?.url ?? '';
      if (ignorable(from) || ignorable(message.text())) return;
      errors.push(from === '' ? message.text() : `${message.text()} <- ${from}`);
    });
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('requestfailed', (request) => {
      if (!ignorable(request.url()))
        failed.push(`${request.url()} ${request.failure()?.errorText ?? ''}`);
    });
    // A 4xx/5xx for a resource the page actually asked for is a failed asset
    // even when the browser does not call the request "failed".
    page.on('response', (response) => {
      if (response.status() < 400 || ignorable(response.url())) return;
      // The document itself is allowed to be a 404 - that is the contract on an
      // unmatched route. This is about the assets a page asked for.
      if (response.request().isNavigationRequest()) return;
      failed.push(`${response.status()} ${response.url()}`);
    });

    await page.goto(origin, { waitUntil: 'networkidle0', timeout: 60_000 });

    const dom = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      title: document.title,
      mains: document.querySelectorAll('main').length,
      h1s: document.querySelectorAll('h1').length,
      h1: document.querySelector('h1')?.textContent?.trim() ?? '',
      canonicals: [...document.querySelectorAll('link[rel="canonical"]')].map(
        (node) => (node as HTMLLinkElement).href,
      ),
      jsonLd: document.querySelectorAll('script[type="application/ld+json"]').length,
      skipLink: document.querySelector('.skip-link, [href="#main"]') !== null,
      contentinfo: document.querySelector('footer, [role="contentinfo"]') !== null,
      viewport: document.querySelector('meta[name="viewport"]') !== null,
      bodyText: (document.body.textContent ?? '').slice(0, 4000),
      styleSheets: document.styleSheets.length,
    }));

    browser.title = dom.title;
    browser.h1 = dom.h1;
    browser.lang = dom.lang;
    browser.canonicals = JSON.stringify(dom.canonicals);

    record(
      'home-200',
      'the page renders a heading in the browser',
      'non-empty h1',
      dom.h1 || '(empty)',
      dom.h1.length > 0,
    );
    record(
      'no-runtime-errors',
      'console and page errors on /',
      'none',
      errors.length === 0 ? 'none' : errors.slice(0, 3).join(' | '),
      errors.length === 0,
    );
    record(
      'no-runtime-errors',
      'failed requests on /',
      'none',
      failed.length === 0 ? 'none' : failed.slice(0, 3).join(' | '),
      failed.length === 0,
    );

    if (contracts.includes('canonical-present')) {
      record(
        'canonical-present',
        'canonical in the live DOM',
        'exactly one',
        JSON.stringify(dom.canonicals),
        dom.canonicals.length === 1,
      );
    }
    if (contracts.includes('canonical-absent-url-less')) {
      record(
        'canonical-absent-url-less',
        'canonical in the live DOM',
        'none',
        JSON.stringify(dom.canonicals),
        dom.canonicals.length === 0,
      );
    }
    if (contracts.includes('json-ld-present')) {
      record(
        'json-ld-present',
        'JSON-LD in the live DOM',
        'exactly one',
        String(dom.jsonLd),
        dom.jsonLd === 1,
      );
    }
    if (contracts.includes('stylesheet-loads')) {
      record(
        'stylesheet-loads',
        'the browser applied a stylesheet',
        'at least one',
        String(dom.styleSheets),
        dom.styleSheets > 0,
      );
    }
    if (contracts.includes('accessibility-structure')) {
      for (const [what, expected, actual, ok] of [
        ['document language', 'non-empty', dom.lang || '(empty)', dom.lang.length > 0],
        ['document title', 'non-empty', dom.title || '(empty)', dom.title.length > 0],
        ['exactly one main', '1', String(dom.mains), dom.mains === 1],
        ['exactly one h1', '1', String(dom.h1s), dom.h1s === 1],
        ['skip link', 'present', dom.skipLink ? 'present' : 'absent', dom.skipLink],
        [
          'contentinfo landmark',
          'present',
          dom.contentinfo ? 'present' : 'absent',
          dom.contentinfo,
        ],
        ['viewport meta', 'present', dom.viewport ? 'present' : 'absent', dom.viewport],
      ] as [string, string, string, boolean][]) {
        record('accessibility-structure', what, expected, actual, ok);
      }
    }
    if (contracts.includes('mui-renders')) {
      const mui = await page.evaluate(
        () => document.querySelector('[class*="Mui"], [class*="css-"]') !== null,
      );
      record(
        'mui-renders',
        'MUI-generated styling is present in the DOM',
        'present',
        mui ? 'present' : 'absent',
        mui,
      );
      record(
        'mui-renders',
        'no provider or hydration error',
        'none',
        errors.length === 0 ? 'none' : errors.slice(0, 2).join(' | '),
        errors.length === 0,
      );
    }

    // --- client-side routing ------------------------------------------------
    if (contracts.includes('router-route-loads')) {
      record(
        'router-route-loads',
        'the router mounted the configured route',
        'home content',
        dom.h1 || '(empty)',
        dom.h1.length > 0,
      );
    }
    if (contracts.includes('client-fallback-200')) {
      /*
       * The Stage 13 distinction, observed rather than asserted: an address the
       * client router does not know must still be a 200 with the application on
       * it, because a browser-side fallback is not an HTTP 404. Getting this
       * wrong in either direction - a 404 from the server, or a blank page -
       * is what this case exists to catch.
       */
      const unknown = `${origin}/definitely-not-a-route`;
      const response = await page.goto(unknown, { waitUntil: 'networkidle0', timeout: 60_000 });
      const status = response?.status() ?? 0;
      record(
        'client-fallback-200',
        'GET an unknown client route',
        '200',
        String(status),
        status === 200,
      );

      const fallback = await page.evaluate(() => ({
        h1: document.querySelector('h1')?.textContent?.trim() ?? '',
        mounted: document.querySelector('#root, [data-reactroot], main') !== null,
      }));
      browser.fallbackH1 = fallback.h1;
      record(
        'client-fallback-200',
        'the application mounted on the unknown route',
        'mounted',
        fallback.mounted ? 'mounted' : 'not mounted',
        fallback.mounted,
      );
      record(
        'client-fallback-200',
        'the client fallback view rendered',
        'a not-found heading',
        fallback.h1 || '(empty)',
        /does not exist|not found|doesn't exist/i.test(fallback.h1),
      );
      record(
        'client-fallback-200',
        'no runtime error on the fallback route',
        'none',
        errors.length === 0 ? 'none' : errors.slice(0, 2).join(' | '),
        errors.length === 0,
      );
    }

    // --- Next: the 404 document in the live DOM -----------------------------
    if (combination.framework === 'nextjs' && contracts.includes('not-found-404')) {
      await page.goto(`${origin}/nope`, { waitUntil: 'networkidle0', timeout: 60_000 });
      const missing = await page.evaluate(() => ({
        h1: document.querySelector('h1')?.textContent?.trim() ?? '',
        canonicals: document.querySelectorAll('link[rel="canonical"]').length,
      }));
      browser.notFoundH1 = missing.h1;
      record(
        'not-found-404',
        'the not-found page renders in the browser',
        'a not-found heading',
        missing.h1 || '(empty)',
        /doesn't exist|not found/i.test(missing.h1),
      );
      if (contracts.includes('canonical-absent-on-404')) {
        record(
          'canonical-absent-on-404',
          'canonical in the live 404 DOM',
          '0',
          String(missing.canonicals),
          missing.canonicals === 0,
        );
      }
    }

    await page.close();
  } finally {
    await instance.close();
  }
}

// ---------------------------------------------------------------------------
// Driving one case
// ---------------------------------------------------------------------------

const flagsFor = (runtimeCase: RuntimeCase): string[] => {
  const { combination, url } = runtimeCase;
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
    '--no-git',
    '--no-install',
    '-y',
  ];
  // A URL-less project is one that was never given a URL, not one that was
  // given a URL and had it removed.
  if (url === 'configured') flags.push('--url', SITE_URL);
  if (combination.features.length > 0) flags.push('--features', combination.features.join(','));
  return flags;
};

async function runCase(runtimeCase: RuntimeCase): Promise<CaseResult> {
  const workspace = mkdtempSync(path.join(tmpdir(), 'ck54-'));
  const target = path.join(workspace, 'acme-site');
  const framework = runtimeCase.combination.framework;

  try {
    const generated = await once(
      process.execPath,
      [CLI, target, ...flagsFor(runtimeCase)],
      workspace,
      120_000,
    );
    if (generated.code !== 0) throw new Error(`generate: ${generated.output.slice(-400)}`);

    addRoutes(target, framework, runtimeCase.addedRoutes);

    const installed = await once('npm', ['install', '--no-audit', '--no-fund'], target, 900_000);
    if (installed.code !== 0) throw new Error(`install: ${installed.output.slice(-400)}`);

    const built = await once('npm', ['run', 'build'], target, 1_200_000);
    if (built.code !== 0) throw new Error(`build: ${built.output.slice(-600)}`);

    return await withServer(target, serveScript(framework), async (origin, port) => {
      const { checks, result } = await examine(runtimeCase, origin, port);
      const record = (
        contract: Contract | 'harness',
        what: string,
        expected: string,
        actual: string,
        ok: boolean,
      ): void => {
        checks.push({ contract, what, expected, actual, ok });
      };
      await inBrowser(runtimeCase, origin, record, result.browser);
      const failures = checks.filter((check) => !check.ok);
      return { ...result, checks, result: failures.length === 0 ? 'pass' : 'fail' };
    });
  } catch (error) {
    return {
      id: runtimeCase.id,
      framework,
      configuration: { ...runtimeCase.combination, url: runtimeCase.url },
      routes: [],
      http: {},
      browser: {},
      features: {},
      contracts: runtimeCase.contracts,
      checks: [],
      result: 'fail',
      failure: String(error).slice(0, 700),
    };
  } finally {
    // Belt and braces: the server was already asked to stop, and anything still
    // running out of this directory is stopped by name before it is removed.
    await killByWorkspace(workspace);
    try {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch {
      // A just-killed server can still hold its own directory open on Windows
      // for a moment. Remembered and swept once at the end rather than failing
      // a measurement over a file handle.
      stubborn.push(workspace);
    }
  }
}

// ---------------------------------------------------------------------------

const adapters = createAdapterRegistry(findTemplatesRoot(path.join(ROOT, 'src')));
const matrix = runtimeMatrix(adapters);
const selected = matrix.cases.filter((entry) => ONLY === '' || entry.id.includes(ONLY));
const missing = matrix.required.filter((tuple) => !matrix.covered.includes(tuple));

console.log(`runtime cases: ${selected.length} of ${matrix.cases.length}`);
console.log(
  `coverage: ${matrix.covered.length}/${matrix.required.length} tuples, missing ${missing.length}`,
);
console.log(`node ${process.version}\n`);

/** Workspaces a just-killed server was still holding. */
const stubborn: string[] = [];

const results: CaseResult[] = [];
for (const runtimeCase of selected) {
  const started = Date.now();
  const result = await runCase(runtimeCase);
  results.push(result);
  const failed = result.checks.filter((check) => !check.ok);
  console.log(
    `${result.result === 'pass' ? 'ok  ' : 'FAIL'} ${runtimeCase.id}  ` +
      `(${result.checks.length} checks, ${((Date.now() - started) / 1000).toFixed(0)}s)`,
  );
  if (result.failure) console.log(`       ${result.failure.replace(/\s+/g, ' ').slice(0, 400)}`);
  for (const check of failed) {
    console.log(
      `       ${check.contract}: ${check.what} — expected ${check.expected}, got ${check.actual}`,
    );
  }
}

const passed = results.filter((entry) => entry.result === 'pass');
const totalChecks = results.reduce((sum, entry) => sum + entry.checks.length, 0);
const failedChecks = results.reduce(
  (sum, entry) => sum + entry.checks.filter((check) => !check.ok).length,
  0,
);

console.log(`\n${'='.repeat(70)}`);
console.log(`cases   : ${passed.length}/${results.length}`);
console.log(`checks  : ${totalChecks - failedChecks}/${totalChecks}`);
const exercised = [...new Set(results.flatMap((entry) => entry.contracts))].sort();
console.log(`contracts exercised: ${exercised.length} — ${exercised.join(', ')}`);

if (!REPEAT && ONLY === '') {
  const artifact = results.map((entry) => ({
    id: entry.id,
    framework: entry.framework,
    configuration: entry.configuration,
    routes: entry.routes,
    http: entry.http,
    browser: entry.browser,
    features: entry.features,
    contracts: entry.contracts,
    checks: entry.checks.length,
    result: entry.result,
    ...(entry.failure ? { failure: entry.failure } : {}),
  }));
  writeFileSync(
    path.join(ROOT, 'docs', 'runtime-matrix.json'),
    `${JSON.stringify({ coverage: { required: matrix.required, covered: matrix.covered }, cases: artifact }, null, 2)}\n`,
    'utf8',
  );
  console.log('\nwrote docs/runtime-matrix.json');
}

/*
 * Nothing may outlive the run.
 *
 * A pause first: a stopped server's file handles are released a moment after
 * the process itself goes, so the immediate retry can still lose to Windows on
 * a directory that deletes cleanly seconds later. What cannot be removed even
 * then is named rather than quietly left behind.
 */
await sleep(5_000);
for (const workspace of [...stubborn]) {
  try {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    stubborn.splice(stubborn.indexOf(workspace), 1);
  } catch {
    /* reported rather than hidden */
  }
}
if (stubborn.length > 0) {
  console.log(`\n${stubborn.length} temporary workspace(s) could not be removed:`);
  for (const workspace of stubborn) console.log(`  ${path.basename(workspace)}`);
}
process.exit(failedChecks === 0 && passed.length === results.length ? 0 : 1);
