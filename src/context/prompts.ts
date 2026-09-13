import * as p from '@clack/prompts';
import pc from 'picocolors';

import { CancelledError, CliError } from '../errors.js';
import type { TemplateMode } from '../types.js';
import type { Validation } from './validate.js';

export interface SetupAnswer {
  readonly install: boolean;
  readonly git: boolean;
}

/** One selectable answer. `value` is a domain id; the rest is presentation. */
export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string | undefined;
}

/**
 * A question about one manifest dimension.
 *
 * Deliberately generic. The prompter renders a list and returns a string; it
 * never learns that `react-router` is a router or that `mui` needs React.
 * Which choices exist, and which of them are worth offering, is decided by the
 * layer that can ask the registry and the compatibility engine - and that is
 * what keeps a per-framework questionnaire out of the UI.
 */
export interface DimensionQuestion {
  /** The dimension being configured, for diagnostics and tests. */
  readonly dimension: string;
  readonly message: string;
  readonly options: readonly ChoiceOption[];
  /** What "just press Enter" means. Always one of `options`. */
  readonly initialValue: string;
}

/** The same, for a dimension that takes several answers. */
export interface MultiChoiceQuestion {
  readonly dimension: string;
  readonly message: string;
  readonly options: readonly ChoiceOption[];
  readonly initialValues: readonly string[];
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
  /** One dimension, one answer. Returns a domain id from `question.options`. */
  selectDimension(question: DimensionQuestion): Promise<string>;
  /** One dimension, several answers. Returns domain ids from `question.options`. */
  selectMany(question: MultiChoiceQuestion): Promise<readonly string[]>;
  /** Explicit consent before writing into a directory that already has files. */
  confirmNonEmpty(collisionCount: number): Promise<boolean>;
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

  async selectDimension(question: DimensionQuestion): Promise<string> {
    return unwrap(
      await p.select<string>({
        message: question.message,
        initialValue: question.initialValue,
        options: question.options.map((option) => ({
          value: option.value,
          label: option.label,
          ...(option.hint === undefined ? {} : { hint: option.hint }),
        })),
      }),
    );
  }

  async selectMany(question: MultiChoiceQuestion): Promise<readonly string[]> {
    return unwrap(
      await p.multiselect<string>({
        message: question.message,
        initialValues: [...question.initialValues],
        // Choosing nothing is a real answer here, not an empty form.
        required: false,
        options: question.options.map((option) => ({
          value: option.value,
          label: option.label,
          ...(option.hint === undefined ? {} : { hint: option.hint }),
        })),
      }),
    );
  }

  async confirmNonEmpty(collisionCount: number): Promise<boolean> {
    return unwrap(
      await p.confirm({
        message:
          collisionCount > 0
            ? `Continue and replace ${collisionCount} existing file(s)?`
            : 'Continue and add files to this directory?',
        // Destructive by default means "no": the user must opt in.
        initialValue: false,
      }),
    );
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
  selectDimension(question: DimensionQuestion): Promise<string> {
    this.#fail(`the ${question.dimension}`);
  }
  selectMany(question: MultiChoiceQuestion): Promise<readonly string[]> {
    this.#fail(`the ${question.dimension}`);
  }

  confirmNonEmpty(): Promise<boolean> {
    this.#fail('confirmation to write into a non-empty directory');
  }
}
