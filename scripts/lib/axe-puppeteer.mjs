import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * Minimal axe-core driver for Puppeteer.
 *
 * `@axe-core/puppeteer` exists but is another dependency and another version
 * to keep in step with Puppeteer. Injecting axe-core's own bundle and calling
 * `axe.run` is the whole of what this project needs, so it lives here instead.
 */
const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

export class AxePuppeteer {
  #page;
  #tags = null;

  constructor(page) {
    this.#page = page;
  }

  /** Limit the run to specific rule tags, e.g. wcag2aa. */
  withTags(tags) {
    this.#tags = tags;
    return this;
  }

  async analyze() {
    await this.#page.evaluate(axeSource);
    return this.#page.evaluate(async (tags) => {
      const options = tags ? { runOnly: { type: 'tag', values: tags } } : {};

      return window.axe.run(document, options);
    }, this.#tags);
  }
}
