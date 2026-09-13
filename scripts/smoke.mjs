#!/usr/bin/env node
/**
 * Clean-room end-to-end test of the real product path:
 *
 *   npm pack -> fresh dir -> install tarball -> generate -> install -> check -> build
 *
 * Nothing here reads the source template directory. If the tarball is missing a
 * file, this is what catches it.
 *
 * Usage:
 *   node scripts/smoke.mjs                 all scenarios
 *   node scripts/smoke.mjs --quick         skip generated-project install/build
 *   node scripts/smoke.mjs --keep          leave the workspace for inspection
 *   node scripts/smoke.mjs --audit         also run axe + Lighthouse on each build
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const QUICK = process.argv.includes('--quick');
const AUDIT = process.argv.includes('--audit');
const KEEP = process.argv.includes('--keep');
const WIN = process.platform === 'win32';

const repoRoot = process.cwd();
const failures = [];
let checks = 0;

function expect(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

function record(label, error) {
  const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`
    .trim()
    .split('\n')
    .slice(-12)
    .join('\n');
  failures.push(`${label} failed:\n${detail}`);
  // Surfaced immediately so a CI log shows the cause next to the step.
  console.error(`  FAIL  ${label}\n${detail.replace(/^/gm, '        ')}`);
  return null;
}

/**
 * npm has to go through a shell on Windows because its entry point is a .cmd
 * shim, so every argument here must be shell-safe. Only fixed subcommands and
 * quoted paths are ever passed.
 */
function npm(args, cwd, label) {
  const safe = args.map((arg) => (WIN && /[\s&()]/.test(arg) ? `"${arg}"` : arg));
  try {
    return execFileSync(WIN ? 'npm.cmd' : 'npm', safe, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      shell: WIN,
      env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' },
    });
  } catch (error) {
    return record(label, error);
  }
}

/**
 * Runs the installed CLI through Node directly. No shell is involved, so
 * arguments containing spaces or ampersands ("A & B Design Studio") arrive
 * exactly as written - which a shell-quoted invocation cannot guarantee across
 * platforms.
 */
function cliRun(cliEntry, args, cwd, label) {
  try {
    return execFileSync(process.execPath, [cliEntry, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    return record(label, error);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// --- build the artifact ------------------------------------------------------

const workspace = mkdtempSync(path.join(tmpdir(), 'ck-smoke-'));

section('packing');

/*
 * The tarball is written into the temporary workspace, never the repository.
 *
 * This runs inside `prepublishOnly`, so `npm publish` is packing the very same
 * directory at the same time. Packing here too - and then deleting the result
 * on cleanup - destroyed the tarball publish was about to upload. Keeping every
 * artifact inside the workspace means this check cannot interfere with whatever
 * invoked it.
 */
const packOutput = execFileSync('npm', ['pack', '--json', '--pack-destination', workspace], {
  cwd: repoRoot,
  encoding: 'utf8',
  shell: WIN,
});
const tarballName = (JSON.parse(packOutput)[0] ?? {}).filename;
const tarball = path.join(workspace, tarballName);
console.log(`  ${tarballName}`);
console.log(`  workspace: ${workspace}`);

function cleanup() {
  if (KEEP) {
    console.log(`\nworkspace kept at ${workspace}`);
    return;
  }
  // Removing the workspace removes the tarball with it.
  rmSync(workspace, { recursive: true, force: true });
}

try {
  // --- install the CLI from the tarball, exactly as a user would -------------

  section('clean-room install');
  writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify({ name: 'smoke', private: true }),
  );
  npm(['install', tarball, '--no-fund', '--no-audit'], workspace, 'tarball install');

  const installed = readdirSync(path.join(workspace, 'node_modules')).filter(
    (name) => !name.startsWith('.'),
  );
  expect(
    installed.length === 1 && installed[0] === 'create-clientkit',
    `installing the CLI pulled in extra packages: ${installed.join(', ')}`,
  );
  console.log(`  installed packages: ${installed.join(', ')}`);

  // The platform shim npm links for users - a .cmd on Windows. Exercised with
  // simple arguments to prove the shim itself runs, the way `npm create` uses it.
  const shim = path.join(
    workspace,
    'node_modules',
    '.bin',
    WIN ? 'create-clientkit.cmd' : 'create-clientkit',
  );
  expect(existsSync(shim), 'CLI binary was not linked into node_modules/.bin');

  let viaShim = null;
  try {
    viaShim = execFileSync(shim, ['--version'], { cwd: workspace, encoding: 'utf8', shell: WIN });
  } catch (error) {
    record('bin shim --version', error);
  }
  expect(
    viaShim !== null && /^\d+\.\d+\.\d+/.test(viaShim.trim()),
    'the linked bin shim did not run',
  );

  // Everything else runs the entry point through Node directly, so arguments
  // containing spaces or ampersands survive intact on every platform.
  const cli = path.join(workspace, 'node_modules', 'create-clientkit', 'bin', 'cli.js');
  expect(existsSync(cli), 'bin/cli.js missing from the installed package');

  const list = cliRun(cli, ['--list-templates'], workspace, '--list-templates');
  expect(list?.includes('astro-tailwind'), '--list-templates did not report the template');

  // --- scenarios -------------------------------------------------------------

  const scenarios = [
    {
      name: 'coming-soon',
      args: ['--mode', 'coming-soon', '--name', 'Acme Ltd', '--url', 'https://acme.example'],
      siteName: 'Acme Ltd',
      url: true,
    },
    {
      name: 'full',
      args: ['--mode', 'full', '--name', 'A & B Design Studio', '--url', 'https://acme.example'],
      siteName: 'A & B Design Studio',
      url: true,
    },
    {
      name: 'no-url',
      args: ['--mode', 'coming-soon', '--name', 'Acme Ltd'],
      siteName: 'Acme Ltd',
      url: false,
    },
  ];

  for (const scenario of scenarios) {
    section(`scenario: ${scenario.name}`);
    const dir = path.join(workspace, scenario.name);

    cliRun(
      cli,
      [scenario.name, '--yes', '--no-install', '--no-git', ...scenario.args],
      workspace,
      `generate ${scenario.name}`,
    );

    if (!existsSync(dir)) {
      failures.push(`${scenario.name}: generation produced no directory`);
      continue;
    }

    expect(existsSync(path.join(dir, 'package.json')), `${scenario.name}: no package.json`);
    expect(existsSync(path.join(dir, '.client-site.json')), `${scenario.name}: no provenance file`);
    expect(existsSync(path.join(dir, 'public', 'favicon.svg')), `${scenario.name}: no favicon`);
    expect(
      existsSync(path.join(dir, 'src', 'components', 'Seo.astro')),
      `${scenario.name}: SEO component missing from the artifact`,
    );

    // Unresolved tokens anywhere means the engine or the tarball is broken.
    const walk = (d) =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
      );
    for (const file of walk(dir)) {
      const text = readFileSync(file, 'utf8');
      expect(!/\{\{[a-zA-Z]+\}\}/.test(text), `${scenario.name}: unresolved token in ${file}`);
      expect(!text.includes('\r\n'), `${scenario.name}: CRLF written to ${path.basename(file)}`);
    }

    const generatedPkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    expect(generatedPkg.private === true, `${scenario.name}: generated project is not private`);
    expect(
      generatedPkg.license === 'UNLICENSED',
      `${scenario.name}: generated licence is ${generatedPkg.license}`,
    );
    expect(
      !existsSync(path.join(dir, 'LICENSE')),
      `${scenario.name}: an MIT LICENSE leaked into the client project`,
    );

    if (QUICK) {
      console.log('  generated (skipping install/build: --quick)');
      continue;
    }

    npm(['install', '--no-fund', '--no-audit'], dir, `${scenario.name}: npm install`);
    npm(['run', 'check'], dir, `${scenario.name}: astro check`);
    npm(['run', 'build'], dir, `${scenario.name}: astro build`);

    const distDir = path.join(dir, 'dist');
    expect(existsSync(path.join(distDir, 'index.html')), `${scenario.name}: no index.html`);
    expect(existsSync(path.join(distDir, '404.html')), `${scenario.name}: no 404.html`);
    expect(
      existsSync(path.join(distDir, 'favicon.svg')),
      `${scenario.name}: favicon not published`,
    );
    expect(existsSync(path.join(distDir, 'robots.txt')), `${scenario.name}: no robots.txt`);

    const html = readFileSync(path.join(distDir, 'index.html'), 'utf8');
    const head = html.slice(0, html.indexOf('</head>'));
    const count = (re) => (head.match(re) ?? []).length;

    expect(count(/<title>/g) === 1, `${scenario.name}: expected exactly one <title>`);
    expect(count(/name="robots"/g) === 1, `${scenario.name}: expected exactly one robots tag`);
    expect(count(/rel="canonical"/g) <= 1, `${scenario.name}: duplicate canonical`);
    expect(count(/application\/ld\+json/g) === 1, `${scenario.name}: expected one JSON-LD block`);

    /*
     * The Organization contract, against the JSON-LD a real build emitted.
     *
     * Stage 10 made structured data a feature that computes this object. This
     * is the other end: what Astro actually put in the document. Parsed rather
     * than string-matched, because structured data that looks right and does
     * not parse is worse than none - a crawler discards the whole block.
     */
    const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (ld === null) {
      failures.push(`${scenario.name}: no JSON-LD block`);
    } else {
      const raw = ld[1];
      expect(!raw.includes('[object Object]'), `${scenario.name}: JSON-LD was never serialised`);
      expect(!/[<>]/.test(raw), `${scenario.name}: JSON-LD carries a raw angle bracket`);

      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        failures.push(`${scenario.name}: JSON-LD is not valid JSON`);
      }

      if (parsed !== null) {
        expect(
          parsed['@context'] === 'https://schema.org',
          `${scenario.name}: JSON-LD @context should be the canonical HTTPS schema.org`,
        );
        expect(parsed['@type'] === 'Organization', `${scenario.name}: wrong JSON-LD @type`);
        expect(
          parsed.name === scenario.siteName,
          `${scenario.name}: JSON-LD name should be the site name, found ${parsed.name}`,
        );

        // Nothing invented: a field is present because it is true, or absent.
        for (const [field, value] of Object.entries(parsed)) {
          expect(
            value !== null && value !== undefined && value !== '',
            `${scenario.name}: JSON-LD "${field}" is present but empty`,
          );
        }

        if (scenario.url) {
          expect(
            typeof parsed.url === 'string' && parsed.url.startsWith('https://'),
            `${scenario.name}: JSON-LD url should be absolute, found ${parsed.url}`,
          );
        } else {
          expect(
            !('url' in parsed),
            `no-url: JSON-LD carries a url with no configured site URL: ${parsed.url}`,
          );
        }
      }
    }

    /*
     * Rendered text, not just tags.
     *
     * A formatter once split "{year} {SITE.name}" across two lines, and Astro
     * drops the newline between adjacent expressions - so the footer rendered
     * "2026Acme Studio" with no space. Nothing in the markup looked wrong.
     * This asserts the visible result instead.
     */
    const notice = html.slice(html.indexOf('copyright')).slice(0, 200);
    expect(
      /(?:&copy;|©)\s*\d{4}\s+\S/.test(notice),
      `${scenario.name}: copyright notice is missing a space: ${notice.slice(0, 60)}`,
    );

    /*
     * The SEO contract, against the head a real build emitted.
     *
     * Stage 9 made the metadata contract a framework-independent value that the
     * SEO feature computes. This is the other end of that: the tags Astro
     * actually produced. The two are written independently - one in TypeScript
     * from the site metadata, one here from the arguments the CLI was called
     * with - so if the contract and the template ever disagree, one of them
     * fails against the same build.
     *
     * Entity-decoded because the site name in one scenario contains an
     * ampersand, which is correctly escaped in the attribute.
     */
    const decode = (value) =>
      value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
    const tag = (re) => {
      const match = head.match(re);
      return match === null ? null : decode(match[1]);
    };

    const expected = scenario.siteName;
    expect(
      tag(/<title>([^<]*)<\/title>/) === expected,
      `${scenario.name}: <title> should be the site name, found ${tag(/<title>([^<]*)<\/title>/)}`,
    );
    for (const [label, re] of [
      ['og:title', /<meta property="og:title" content="([^"]*)"/],
      ['og:site_name', /<meta property="og:site_name" content="([^"]*)"/],
      ['twitter:title', /<meta name="twitter:title" content="([^"]*)"/],
    ]) {
      expect(tag(re) === expected, `${scenario.name}: ${label} should be the site name`);
    }

    expect(
      tag(/<meta property="og:type" content="([^"]*)"/) === 'website',
      `${scenario.name}: og:type should be website`,
    );
    expect(
      tag(/<meta name="robots" content="([^"]*)"/) === 'index, follow',
      `${scenario.name}: an ordinary page should be indexable`,
    );
    for (const [label, re] of [
      ['description', /<meta name="description" content="([^"]*)"/],
      ['og:description', /<meta property="og:description" content="([^"]*)"/],
      ['twitter:description', /<meta name="twitter:description" content="([^"]*)"/],
    ]) {
      const value = tag(re);
      expect(
        value !== null && value.trim() !== '',
        `${scenario.name}: ${label} is missing or empty`,
      );
    }
    expect(
      tag(/<meta name="twitter:card" content="([^"]*)"/) !== null,
      `${scenario.name}: twitter:card is missing`,
    );

    /*
     * The accessibility baseline, against a real build.
     *
     * Stage 11 made these a stated contract rather than an implicit property of
     * the template. Asserted here on the emitted document so the guarantees and
     * the generator cannot drift apart - a contract nobody checks is a slogan.
     *
     * Only the eight properties the contract actually claims. Colour contrast,
     * authored content and alt text are deliberately absent, because ClientKit
     * does not guarantee them and asserting them here would imply it does.
     */
    expect(
      /<html[^>]+lang="[a-z]{2,3}(-[A-Za-z0-9]{2,8})*"/.test(html),
      `${scenario.name}: <html lang> is missing or malformed`,
    );
    expect(
      (html.match(/<main\b/g) ?? []).length === 1,
      `${scenario.name}: expected exactly one <main> landmark`,
    );
    const mainId = html.match(/<main\b[^>]*\bid="([^"]+)"/)?.[1] ?? '';
    expect(mainId !== '', `${scenario.name}: the main landmark has no id to skip to`);
    expect(
      html.includes(`<a href="#${mainId}"`),
      `${scenario.name}: no skip link targeting the main landmark`,
    );
    expect(
      html.indexOf(`<a href="#${mainId}"`) < html.indexOf('<main'),
      `${scenario.name}: the skip link comes after the content it skips`,
    );
    expect(
      (html.match(/<footer\b/g) ?? []).length >= 1,
      `${scenario.name}: no contentinfo landmark`,
    );
    expect(
      (html.match(/<h1\b/g) ?? []).length === 1,
      `${scenario.name}: expected exactly one <h1>`,
    );
    for (const nav of html.match(/<nav\b[^>]*>/g) ?? []) {
      // Conditional on purpose: not every page has navigation. What is always
      // true is that navigation, where present, is a named landmark.
      expect(
        /aria-label="[^"]+"|aria-labelledby="[^"]+"/.test(nav),
        `${scenario.name}: a <nav> landmark with no accessible name`,
      );
    }
    const viewport = head.match(/<meta name="viewport"[^>]*content="([^"]*)"/)?.[1] ?? '';
    expect(
      viewport !== '' && !/user-scalable\s*=\s*no|maximum-scale\s*=\s*1\b/.test(viewport),
      `${scenario.name}: the viewport prevents zooming: ${viewport}`,
    );
    expect(
      !/aria-[a-z-]+=""/.test(html),
      `${scenario.name}: an ARIA attribute was emitted with an empty value`,
    );

    // The safety guarantee that matters most: nothing fabricated.
    const fabricated = /yourdomain|your-domain|client-site\.com|example\.com/i;
    expect(!fabricated.test(head), `${scenario.name}: fabricated domain in metadata`);

    const robots = readFileSync(path.join(distDir, 'robots.txt'), 'utf8');
    const hasSitemap = existsSync(path.join(distDir, 'sitemap-index.xml'));

    if (scenario.url) {
      expect(head.includes('rel="canonical"'), `${scenario.name}: canonical missing despite a URL`);
      const canonical = tag(/<link rel="canonical" href="([^"]*)"/);
      expect(
        canonical === tag(/<meta property="og:url" content="([^"]*)"/),
        `${scenario.name}: og:url disagrees with the canonical URL`,
      );
      expect(
        canonical !== null && canonical.startsWith('https://'),
        `${scenario.name}: canonical is not an absolute https URL`,
      );
      expect(hasSitemap, `${scenario.name}: sitemap missing despite a URL`);
      expect(
        robots.includes('Sitemap:'),
        `${scenario.name}: robots.txt does not advertise a sitemap`,
      );
    } else {
      expect(!head.includes('rel="canonical"'), 'no-url: canonical emitted without a URL');
      expect(!head.includes('og:url'), 'no-url: og:url emitted without a URL');
      expect(!hasSitemap, 'no-url: a sitemap was generated without a URL');
      expect(!robots.includes('Sitemap:'), 'no-url: robots.txt advertises a sitemap without a URL');
      expect(!fabricated.test(robots), 'no-url: fabricated domain in robots.txt');
    }

    console.log(`  generated, checked and built (${readdirSync(distDir).length} dist entries)`);

    if (AUDIT) {
      // Reuses the site this scenario just produced, so the audit runs against
      // exactly the bytes the clean-room path generated.
      try {
        const output = execFileSync(
          process.execPath,
          [path.join(repoRoot, 'scripts', 'audit-site.mjs'), distDir, '--label', scenario.name],
          { encoding: 'utf8', cwd: repoRoot },
        );
        for (const line of output.split('\n')) {
          if (/axe|lighthouse|sitemap/.test(line)) console.log(line);
        }
      } catch (error) {
        record(`${scenario.name}: audit`, error);
      }
    }
  }

  // --- CLI behaviour against the packed artifact ------------------------------
  //
  // The scenarios above prove generation works. These prove the flags and the
  // filesystem guarantees behave the same when driven from the installed
  // package rather than the source tree.

  section('CLI behaviour');

  // --dry-run writes nothing at all.
  const dryDir = path.join(workspace, 'dry');
  const dryOut = cliRun(cli, ['dry', '--yes', '--dry-run'], workspace, '--dry-run');
  expect(dryOut?.includes('DRY RUN') === true, '--dry-run did not announce itself');
  expect(/Total: \d+ files/.test(dryOut ?? ''), '--dry-run did not list a file total');
  expect(!existsSync(dryDir), '--dry-run created a directory');
  console.log('  --dry-run: listed files, wrote nothing');

  // --no-git and --no-install are honoured.
  const flagsDir = path.join(workspace, 'flags');
  cliRun(cli, ['flags', '--yes', '--no-install', '--no-git'], workspace, '--no-install --no-git');
  expect(!existsSync(path.join(flagsDir, 'node_modules')), '--no-install still installed');
  expect(!existsSync(path.join(flagsDir, '.git')), '--no-git still initialised a repository');
  console.log('  --no-install / --no-git: honoured');

  // git-init runs when it is not disabled.
  const gitDir = path.join(workspace, 'withgit');
  cliRun(cli, ['withgit', '--yes', '--no-install'], workspace, 'git init post-step');
  expect(existsSync(path.join(gitDir, '.git')), 'git-init post-step did not create a repository');
  console.log('  git-init: repository created');

  // The package manager recorded in provenance follows the detected client.
  const provenance = JSON.parse(readFileSync(path.join(gitDir, '.client-site.json'), 'utf8'));
  expect(
    ['npm', 'pnpm', 'yarn', 'bun'].includes(provenance.config.packageManager),
    `unexpected package manager recorded: ${provenance.config.packageManager}`,
  );
  const pnpmDir = path.join(workspace, 'pm');
  cliRun(cli, ['pm', '--yes', '--no-install', '--no-git', '--pm', 'pnpm'], workspace, '--pm pnpm');
  const pmProvenance = JSON.parse(readFileSync(path.join(pnpmDir, '.client-site.json'), 'utf8'));
  expect(
    pmProvenance.config.packageManager === 'pnpm',
    `--pm pnpm was not recorded, got ${pmProvenance.config.packageManager}`,
  );
  console.log(
    `  package manager: detected ${provenance.config.packageManager}, --pm override works`,
  );

  // Names with characters that break naive shell quoting survive intact.
  const oddDir = path.join(workspace, 'odd-name');
  cliRun(
    cli,
    ['odd-name', '--yes', '--no-install', '--no-git', '--name', 'A & B "Studio" <Test>'],
    workspace,
    'special characters in --name',
  );
  const oddConfig = readFileSync(path.join(oddDir, 'src', 'config', 'site.config.ts'), 'utf8');
  expect(
    oddConfig.includes('A & B "Studio" <Test>') || oddConfig.includes('A & B "Studio" <Test>'),
    'a name with special characters did not survive generation',
  );
  console.log('  special characters: preserved in the generated config');

  // A non-empty directory is refused non-interactively, and nothing is touched.
  const guardDir = path.join(workspace, 'guard');
  mkdirSync(guardDir, { recursive: true });
  writeFileSync(path.join(guardDir, 'KEEP.txt'), 'untouched');
  let refused = false;
  try {
    execFileSync(process.execPath, [cli, 'guard', '--yes', '--no-install', '--no-git'], {
      cwd: workspace,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch {
    refused = true;
  }
  expect(refused, 'a non-empty directory was not refused');
  expect(
    readdirSync(guardDir).join(',') === 'KEEP.txt',
    'a refused run modified the existing directory',
  );
  console.log('  non-empty directory: refused, existing files untouched');

  // No staging directory survives any of the runs above.
  const staging = readdirSync(workspace).filter((entry) => entry.includes('.tmp-'));
  expect(staging.length === 0, `staging directories left behind: ${staging.join(', ')}`);
  console.log('  atomic generation: no staging directories remain');
} finally {
  cleanup();
}

// --- report ------------------------------------------------------------------

console.log(`\n${checks} assertions`);
if (failures.length > 0) {
  console.error(`\nsmoke test FAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('smoke test passed');
