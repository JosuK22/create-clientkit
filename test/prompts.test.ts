import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Clack-backed renderer, tested without a terminal.
 *
 * Every other prompt test injects a fake, which is right for the resolver and
 * wrong for this: the one thing `ClackPrompter` does is translate a question
 * into a Clack call, and a fake replaces exactly the code that does it. A
 * mutation that made `selectDimension` pass the first option instead of the
 * chosen default survived the whole suite for that reason - nothing ran this
 * file's real implementation.
 *
 * So Clack itself is stubbed and the *arguments* are asserted. Not a rendering
 * test - the drawing is Clack's problem, and it has its own - but a wiring one.
 */

const select = vi.fn();
const multiselect = vi.fn();
const isCancel = vi.fn((_value: unknown) => false);

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  select: (...args: unknown[]) => select(...args),
  multiselect: (...args: unknown[]) => multiselect(...args),
  isCancel: (value: unknown) => isCancel(value),
}));

const { ClackPrompter } = await import('../src/context/prompts.js');
const { CancelledError } = await import('../src/errors.js');

const QUESTION = {
  dimension: 'styling',
  message: 'Styling',
  options: [
    { value: 'tailwind', label: 'Tailwind CSS' },
    { value: 'bootstrap', label: 'Bootstrap' },
    { value: 'none', label: 'None', hint: 'bring your own' },
  ],
  initialValue: 'bootstrap',
} as const;

beforeEach(() => {
  select.mockReset();
  multiselect.mockReset();
  isCancel.mockReset();
  isCancel.mockReturnValue(false);
});

describe('a single-answer question reaches Clack intact', () => {
  it('passes the question’s own default, not the first option', async () => {
    select.mockResolvedValue('bootstrap');
    await new ClackPrompter().selectDimension(QUESTION);

    const call = select.mock.calls[0]?.[0] as { initialValue: string };
    expect(call.initialValue).toBe('bootstrap');
    // The distinction the mutation exploited: the default is deliberately not
    // the head of the list.
    expect(call.initialValue).not.toBe(QUESTION.options[0].value);
  });

  it('passes every option, in order, with its label', async () => {
    select.mockResolvedValue('tailwind');
    await new ClackPrompter().selectDimension(QUESTION);

    const call = select.mock.calls[0]?.[0] as {
      message: string;
      options: { value: string; label: string; hint?: string }[];
    };
    expect(call.message).toBe('Styling');
    expect(call.options.map((option) => option.value)).toEqual(['tailwind', 'bootstrap', 'none']);
    expect(call.options.map((option) => option.label)).toEqual([
      'Tailwind CSS',
      'Bootstrap',
      'None',
    ]);
  });

  it('carries a hint where one exists and omits the key where none does', async () => {
    select.mockResolvedValue('none');
    await new ClackPrompter().selectDimension(QUESTION);

    const options = (select.mock.calls[0]?.[0] as { options: Record<string, unknown>[] }).options;
    expect(options[2]?.['hint']).toBe('bring your own');
    expect(options[0]).not.toHaveProperty('hint');
  });

  it('returns what the user picked', async () => {
    select.mockResolvedValue('bootstrap');
    expect(await new ClackPrompter().selectDimension(QUESTION)).toBe('bootstrap');
  });

  it('turns a cancel into a CancelledError rather than a value', async () => {
    select.mockResolvedValue(Symbol('cancel'));
    isCancel.mockReturnValue(true);
    await expect(new ClackPrompter().selectDimension(QUESTION)).rejects.toBeInstanceOf(
      CancelledError,
    );
  });
});

describe('a multi-answer question reaches Clack intact', () => {
  const MULTI = {
    dimension: 'features',
    message: 'Features',
    options: [
      { value: 'seo', label: 'Search-engine metadata' },
      { value: 'accessibility', label: 'Accessibility baseline' },
    ],
    initialValues: [],
  } as const;

  it('is optional, because choosing nothing is a real answer', async () => {
    multiselect.mockResolvedValue([]);
    await new ClackPrompter().selectMany(MULTI);
    expect((multiselect.mock.calls[0]?.[0] as { required: boolean }).required).toBe(false);
  });

  it('passes the options and the initial selection', async () => {
    multiselect.mockResolvedValue(['seo']);
    await new ClackPrompter().selectMany({ ...MULTI, initialValues: ['seo'] });

    const call = multiselect.mock.calls[0]?.[0] as {
      options: { value: string }[];
      initialValues: string[];
    };
    expect(call.options.map((option) => option.value)).toEqual(['seo', 'accessibility']);
    expect(call.initialValues).toEqual(['seo']);
  });

  it('returns every selection', async () => {
    multiselect.mockResolvedValue(['seo', 'accessibility']);
    expect(await new ClackPrompter().selectMany(MULTI)).toEqual(['seo', 'accessibility']);
  });

  it('turns a cancel into a CancelledError', async () => {
    multiselect.mockResolvedValue(Symbol('cancel'));
    isCancel.mockReturnValue(true);
    await expect(new ClackPrompter().selectMany(MULTI)).rejects.toBeInstanceOf(CancelledError);
  });
});
