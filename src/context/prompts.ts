import * as p from '@clack/prompts';
import pc from 'picocolors';

import { CancelledError, CliError } from '../errors.js';
import type { TemplateMode } from '../types.js';
import type { Validation } from './validate.js';

export interface SetupAnswer {
  readonly install: boolean;
  readonly git: boolean;
}

/**
 * Prompts are an *input source* for the resolver, never a driver of generation.
 * The interface is injectable so the resolution layer can be tested without a
 * TTY and without stubbing stdin.
 */
export interface Prompter {
  readonly interactive: boolean;
  projectDir(defaultValue: string, validate: (value: string) => Validation): Promise<string>;
  siteName(defaultValue: string, validate: (value: string) => Validation): Promise<string>;
  productionUrl(validate: (value: string) => Validation): Promise<string | null>;
  mode(defaultValue: TemplateMode): Promise<TemplateMode>;
  setup(defaults: SetupAnswer): Promise<SetupAnswer>;
}

function unwrap<T>(value: T | symbol): T {
  if (p.isCancel(value)) throw new CancelledError();
  return value as T;
}

/** Clack-backed implementation. The only place that touches stdin. */
export class ClackPrompter implements Prompter {
  readonly interactive = true;

  intro(version: string): void {
    p.intro(`${pc.bgCyan(pc.black(' create-clientkit '))} ${pc.dim(`v${version}`)}`);
  }

  outro(message: string): void {
    p.outro(message);
  }

  async projectDir(defaultValue: string, validate: (value: string) => Validation): Promise<string> {
    return unwrap(
      await p.text({
        message: 'Project directory',
        placeholder: defaultValue,
        defaultValue,
        validate: (value) =>
          validate(value.trim() === '' ? defaultValue : value.trim()) ?? undefined,
      }),
    );
  }

  async siteName(defaultValue: string, validate: (value: string) => Validation): Promise<string> {
    return unwrap(
      await p.text({
        message: 'Client / site name',
        placeholder: defaultValue,
        defaultValue,
        validate: (value) =>
          validate(value.trim() === '' ? defaultValue : value.trim()) ?? undefined,
      }),
    );
  }

  async productionUrl(validate: (value: string) => Validation): Promise<string | null> {
    const answer = unwrap(
      await p.text({
        message: 'Production URL',
        placeholder: 'https://example.com (optional - press Enter to skip)',
        defaultValue: '',
        validate: (value) =>
          value.trim() === '' ? undefined : (validate(value.trim()) ?? undefined),
      }),
    );
    const trimmed = answer.trim();
    return trimmed === '' ? null : trimmed;
  }

  async mode(defaultValue: TemplateMode): Promise<TemplateMode> {
    return unwrap(
      await p.select<TemplateMode>({
        message: 'Starting mode',
        initialValue: defaultValue,
        options: [
          {
            value: 'coming-soon',
            label: 'Coming Soon',
            hint: 'a single launch page you can put live today',
          },
          {
            value: 'full',
            label: 'Full Starter',
            hint: 'home page and sections, coming-soon route included',
          },
        ],
      }),
    );
  }

  async setup(defaults: SetupAnswer): Promise<SetupAnswer> {
    const initial: string[] = [];
    if (defaults.install) initial.push('install');
    if (defaults.git) initial.push('git');

    const selected = unwrap(
      await p.multiselect<string>({
        message: 'Setup',
        initialValues: initial,
        required: false,
        options: [
          { value: 'install', label: 'Install dependencies' },
          { value: 'git', label: 'Initialize Git' },
        ],
      }),
    );
    return { install: selected.includes('install'), git: selected.includes('git') };
  }
}

/**
 * Used when prompting is impossible (--yes, or a non-TTY stdin). Any call is a
 * bug in the resolver: it means a required value slipped through unresolved.
 */
export class NonInteractivePrompter implements Prompter {
  readonly interactive = false;
  readonly #reason: string;

  constructor(reason: string) {
    this.#reason = reason;
  }

  #fail(field: string): never {
    throw new CliError(`Cannot ask for ${field}: ${this.#reason}`, {
      hint: 'Supply the value with a flag or in the --from config file.',
    });
  }

  projectDir(): Promise<string> {
    this.#fail('the project directory');
  }
  siteName(): Promise<string> {
    this.#fail('the site name');
  }
  productionUrl(): Promise<string | null> {
    this.#fail('the production URL');
  }
  mode(): Promise<TemplateMode> {
    this.#fail('the starting mode');
  }
  setup(): Promise<SetupAnswer> {
    this.#fail('the setup options');
  }
}
