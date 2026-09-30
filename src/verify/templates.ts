import path from 'node:path';

import { planManifest } from '../adapters/bridge.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { TemplateCatalog } from '../adapters/template-catalog.js';
import { manifestFrom, resolveDimensions } from '../context/dimensions.js';
import { FRAMEWORK_SIGNATURES } from '../detect/signatures.js';
import { CliError } from '../errors.js';
import { realPlanFs, type PlanFs } from '../generate/plan.js';
import type { TemplateRegistry } from '../templates/registry.js';
import type { TemplateDefinition } from '../templates/definition.js';
import {
  toResult,
  type TemplateIssue,
  type TemplateValidationResult,
} from '../templates/validation.js';

/**
 * Plan-level template validation: does each template produce a valid
 * Generation Plan for its framework, for every mode it declares?
 *
 * Separate from `validation.ts` because it has to plan, and planning validates
 * templates - so the planner cannot call this, and this is not on the path of an
 * ordinary run. The tests and the package check run it. It plans exactly as a
 * run does: the framework's default stack, resolved by `resolveDimensions`,
 * planned by `planManifest`. There is no second planner here and no second set
 * of stack rules. Every stack ClientKit accepts is planned by the test suite;
 * this checks the template, so the one stack its framework resolves to by
 * default is the fixed point.
 *
 * Checks what only a plan can show:
 *
 *   - `plan-invalid`          the template cannot be planned at all
 *   - `plan-nondeterministic` two plans of the same input differ
 *   - `plan-source-outside`   a copied file is read from outside the templates
 *   - `framework-version`     the `frameworkVersion` a project records is not
 *                             the version the adapter installs
 *
 * Reads and plans; writes nothing.
 */

export interface VerifyOptions {
  readonly adapters: AdapterRegistry;
  readonly registry: TemplateRegistry;
  readonly templatesRoot: string;
  readonly fs?: PlanFs;
}

/** The identity plans need and nothing else; fixed so two plans can be compared. */
const IDENTITY = {
  targetDir: path.resolve('/clientkit-template-verification/site'),
  projectName: 'site',
  site: {
    name: 'Site',
    url: 'https://example.invalid',
    description: 'Template verification.',
    locale: 'en',
    author: null,
  },
  packageManager: 'npm',
  git: false,
  install: false,
} as const;

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function verifyOne(definition: TemplateDefinition, options: VerifyOptions): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const fs = options.fs ?? realPlanFs;
  const framework = definition.framework as keyof typeof FRAMEWORK_SIGNATURES;
  const realRoot = fs.realpath?.(options.templatesRoot) ?? options.templatesRoot;

  for (const mode of definition.modes) {
    const at = { templateId: definition.id, mode } as const;
    const plan = () =>
      planManifest(
        manifestFrom(
          IDENTITY,
          resolveDimensions({ framework: definition.framework }, options.adapters),
          mode,
        ),
        {
          registry: options.registry,
          cliVersion: '0.0.0',
          generatedAt: '2000-01-01T00:00:00.000Z',
          mode,
          templateId: definition.id,
          fs,
        },
      );

    let first: ReturnType<typeof plan>;
    try {
      first = plan();
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      issues.push({
        ...at,
        code: 'plan-invalid',
        severity: 'error',
        message: `Template "${definition.id}" cannot be planned in mode "${mode}": ${error.message}`,
        ...(error.hint === undefined ? {} : { hint: error.hint }),
      });
      continue;
    }

    if (JSON.stringify(plan().plan) !== JSON.stringify(first.plan)) {
      issues.push({
        ...at,
        code: 'plan-nondeterministic',
        severity: 'error',
        message: `Template "${definition.id}" planned twice in mode "${mode}" gives two different plans.`,
        hint: 'Something in planning depends on order, time or the environment.',
      });
    }

    for (const operation of first.plan.operations) {
      if (operation.type !== 'copy') continue;
      const real = fs.realpath?.(operation.source) ?? operation.source;
      if (!isInside(realRoot, real)) {
        issues.push({
          ...at,
          code: 'plan-source-outside',
          severity: 'error',
          message: `Template "${definition.id}" copies "${operation.path}" from outside the shipped templates (${real}).`,
          hint: 'Every copied file must come from the templates directory in the package.',
          destination: operation.path,
        });
      }
    }

    // The package that proves the framework, as detection names it, and the
    // version the composed package.json actually installs.
    const signature = FRAMEWORK_SIGNATURES[framework];
    const installed = first.composedPackage?.dependencies.find((dependency) =>
      (signature.packages as readonly string[]).includes(dependency.name),
    );
    if (installed === undefined) {
      issues.push({
        ...at,
        code: 'framework-version',
        severity: 'error',
        message: `Template "${definition.id}" plans no ${signature.packages.join(' or ')} dependency in mode "${mode}".`,
        hint: 'The framework package must be installed by the plan.',
      });
    } else if (installed.version !== definition.frameworkVersion) {
      issues.push({
        ...at,
        code: 'framework-version',
        severity: 'error',
        message:
          `Template "${definition.id}" records frameworkVersion ${definition.frameworkVersion}, ` +
          `but its plan installs ${installed.name}@${installed.version}.`,
        hint: 'Update "frameworkVersion" in the manifest to the version the adapter pins.',
        variable: 'frameworkVersion',
      });
    }
  }

  return issues;
}

/** Plan-level validation of every template in the catalog, ordered by id. */
export function verifyTemplatePlans(
  catalog: TemplateCatalog,
  options: VerifyOptions,
): readonly TemplateValidationResult[] {
  return catalog
    .list()
    .map((definition) => toResult(definition.id, verifyOne(definition, options)));
}
