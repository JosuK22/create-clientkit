#!/usr/bin/env node
/**
 * Audits a built generated site: accessibility (axe-core), performance and
 * best practices (Lighthouse), and referenced-asset integrity.
 *
 * Runs against a local static server serving the production build, so results
 * do not depend on a network or a deployed site.
 *
 *   node scripts/audit-site.mjs <dist-dir> [--label name] [--no-lighthouse]
 *
 * Exits non-zero when a threshold is missed or a link is broken.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { AxePuppeteer } from './lib/axe-puppeteer.mjs';

const args = process.argv.slice(2);
const distDir = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'dist');
const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : path.basename(distDir);
const runLighthouse = !args.includes('--no-lighthouse');

if (!existsSync(distDir)) {
  console.error(`no such directory: ${distDir}`);
  process.exit(1);
}

/**
 * Lighthouse scores move a little with machine load, so thresholds sit just
 * below what a healthy build produces rather than demanding a perfect 100.
 * Accessibility and SEO are held at 100 because both are deterministic for a
 * static page of this size.
 */
const THRESHOLDS = {
  performance: 0.95,
  accessibility: 1.0,
  'best-practices': 0.95,
  seo: 1.0,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const candidates =
    clean === '/'
      ? ['index.html']
      : [clean.slice(1), `${clean.slice(1)}.html`, path.join(clean.slice(1), 'index.html')];

  for (const candidate of candidates) {
    const full = path.join(distDir, candidate);
    // Never serve outside the build directory.
    if (!full.startsWith(distDir)) continue;
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return null;
}

const server = createServer((req, res) => {
  const file = resolveFile(req.url ?? '/');
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

const failures = [];
const summary = [];

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
console.log(`\n=== auditing ${label} (${origin}) ===`);

const puppeteer = (await import('puppeteer')).default;
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const pages = [
    { route: '/', name: 'home' },
    { route: '/404', name: '404' },
  ];

  // --- accessibility + referenced assets -------------------------------------

  for (const { route, name } of pages) {
    const page = await browser.newPage();

    // Any request the page itself makes must succeed; a 404 here means the
    // page references something that does not ship.
    const broken = [];
    page.on('response', (response) => {
      if (response.status() >= 400) broken.push(`${response.status()} ${response.url()}`);
    });

    const response = await page.goto(`${origin}${route}`, { waitUntil: 'networkidle0' });
    if (!response || !response.ok()) {
      failures.push(`${label} ${name}: route ${route} returned ${response?.status() ?? 'nothing'}`);
      await page.close();
      continue;
    }

    // Wait for the entrance animation to finish before auditing. Sampling
    // mid-fade measures colours no reader ever sees (a half-faded heading
    // reports as ~2:1 contrast) and makes the whole audit non-deterministic.
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
    });

    const results = await new AxePuppeteer(page)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
      .analyze();

    if (results.violations.length > 0) {
      for (const violation of results.violations) {
        failures.push(
          `${label} ${name}: axe ${violation.id} (${violation.impact}) - ${violation.help} ` +
            `[${violation.nodes.length} node(s)]`,
        );
      }
    }
    // "incomplete" means axe could not decide - most often text over the hero's
    // gradient wash. Reported for visibility, but not failed on, because a
    // machine cannot resolve it either way.
    const undecided = results.incomplete.map((entry) => entry.id).join(', ');
    summary.push(
      `  ${label}/${name}: axe ${results.violations.length} violations, ` +
        `${results.passes.length} passes` +
        (undecided === '' ? '' : `, ${results.incomplete.length} undecided (${undecided})`),
    );

    for (const entry of broken) failures.push(`${label} ${name}: broken request ${entry}`);

    // Internal links must resolve within the build.
    const hrefs = await page.$$eval('a[href]', (nodes) => nodes.map((n) => n.getAttribute('href')));
    for (const href of hrefs) {
      if (!href || /^(https?:|mailto:|tel:|#)/.test(href)) continue;
      const target = await fetch(`${origin}${href}`);
      if (!target.ok) failures.push(`${label} ${name}: internal link ${href} -> ${target.status}`);
    }

    await page.close();
  }

  // --- declared assets --------------------------------------------------------

  for (const asset of ['/favicon.svg', '/robots.txt']) {
    const res = await fetch(`${origin}${asset}`);
    if (!res.ok) failures.push(`${label}: ${asset} returned ${res.status}`);
  }

  // robots.txt must only advertise a sitemap that exists.
  const robots = await (await fetch(`${origin}/robots.txt`)).text();
  const sitemapLine = robots.match(/Sitemap:\s*(\S+)/);
  if (sitemapLine) {
    const sitemapPath = new URL(sitemapLine[1]).pathname;
    const res = await fetch(`${origin}${sitemapPath}`);
    if (!res.ok) {
      failures.push(`${label}: robots.txt advertises ${sitemapPath} which returned ${res.status}`);
    } else {
      summary.push(`  ${label}: sitemap advertised and present (${sitemapPath})`);
    }
  } else {
    summary.push(`  ${label}: no sitemap advertised (expected when no URL is configured)`);
  }

  // --- lighthouse --------------------------------------------------------------

  if (runLighthouse) {
    const lighthouse = (await import('lighthouse')).default;
    const endpoint = new URL(browser.wsEndpoint());

    const result = await lighthouse(
      `${origin}/`,
      { port: Number(endpoint.port), output: 'json', logLevel: 'error' },
      undefined,
    );

    const scores = Object.fromEntries(
      Object.entries(result.lhr.categories).map(([key, value]) => [key, value.score]),
    );

    for (const [category, minimum] of Object.entries(THRESHOLDS)) {
      const score = scores[category];
      if (score === null || score === undefined) {
        failures.push(`${label}: lighthouse did not report "${category}"`);
        continue;
      }
      const percent = Math.round(score * 100);
      if (score < minimum) {
        failures.push(
          `${label}: lighthouse ${category} ${percent} is below the ${minimum * 100} threshold`,
        );
      }
      summary.push(`  ${label}: lighthouse ${category} ${percent}`);
    }
  } else {
    summary.push(`  ${label}: lighthouse skipped (--no-lighthouse)`);
  }
} finally {
  await browser.close();
  server.close();
}

for (const line of summary) console.log(line);

if (failures.length > 0) {
  console.error(`\naudit FAILED for ${label} (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\naudit passed for ${label}`);
