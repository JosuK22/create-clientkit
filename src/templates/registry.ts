import type { TemplateMode } from '../types.js';

/**
 * M1 placeholder registry.
 *
 * No templates exist yet and none are faked. This module exists so the
 * resolution layer can already read "template defaults" as a real precedence
 * layer; M2 replaces the body without changing this interface.
 */
export interface TemplateSummary {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly version: string;
  readonly modes: readonly TemplateMode[];
}

/** The subset of ProjectContext a template is allowed to supply defaults for. */
export interface TemplateDefaults {
  readonly mode?: TemplateMode;
  readonly locale?: string;
  readonly description?: string;
}

export interface TemplateRegistry {
  list(): readonly TemplateSummary[];
  has(id: string): boolean;
  defaultsFor(id: string): TemplateDefaults;
}

export const emptyRegistry: TemplateRegistry = {
  list: () => [],
  has: () => false,
  defaultsFor: () => ({}),
};
