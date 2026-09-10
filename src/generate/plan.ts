import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { CliError } from '../errors.js';
import type { TemplateRegistry } from '../templates/registry.js';
import type { ProjectContext } from '../types.js';
import { deepMergeJson, parseJsonLayer, stringifyJson } from './compose.js';
import {
  isMergeableJson,
  isTextFile,
  normaliseEol,
  renameSpecialPath,
  toPosix,
  type FileOperation,
  type GenerationPlan,
} from './files.js';
import { buildProvenance, PROVENANCE_FILE } from './provenance.js';
import { buildTokenValues, substituteTokens, type TokenValues } from './tokens.js';

/** Read-only filesystem access, injectable so planning can be tested in memory. */
export interface PlanFs {
  readDir(dir: string): readonly { name: string; isDirectory: boolean }[];
  readText(file: string): string;
  exists(dir: string): boolean;
}

export const realPlanFs: PlanFs = {
  readDir: (dir) =>
    readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    })),
  readText: (file) => readFileSync(file, 'utf8'),
  exists: (dir) => {
    try {
      readdirSync(dir);
      return true;
    } catch {
      return false;
    }
  },
};

export interface PlanOptions {
  readonly registry: TemplateRegistry;
  readonly fs?: PlanFs;
  readonly now?: Date;
}

interface LayerFile {
  readonly layer: string;
  readonly absolutePath: string;
  /** Relative path inside the layer, before the underscore rename. */
  readonly rawRelativePath: string;
}

function walkLayer(fs: PlanFs, layerRoot: string, layerName: string): LayerFile[] {
  const files: LayerFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readDir(dir)) {
      const absolutePath = path.join(dir, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory) {
        walk(absolutePath, relative);
      } else {
        files.push({ layer: layerName, absolutePath, rawRelativePath: relative });
      }
    }
  };
  if (!fs.exists(layerRoot)) return files;
  walk(layerRoot, '');
  return files;
}

/** Substitutes tokens inside JSON string values only, so quoting stays valid. */
function substituteInJson(value: unknown, values: TokenValues, label: string): unknown {
  if (typeof value === 'string') return substituteTokens(value, values, label);
  if (Array.isArray(value)) return value.map((item) => substituteInJson(item, values, label));
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[substituteTokens(key, values, label)] = substituteInJson(entry, values, label);
    }
    return result;
  }
  return value;
}

/**
 * Builds the complete generation plan in memory.
 *
 * Reads template files; writes nothing, creates nothing, and mutates nothing.
 * Given the same context and template it returns byte-identical operations, so
 * the output can be snapshotted and diffed.
 */
export function plan(context: ProjectContext, options: PlanOptions): GenerationPlan {
  const fs = options.fs ?? realPlanFs;
  const now = options.now ?? new Date(context.generatedAt);
  const manifest = options.registry.get(context.template.id);

  if (!manifest.supportedModes.includes(context.template.mode)) {
    throw new CliError(
      `Template "${manifest.id}" does not support mode "${context.template.mode}".`,
      { hint: `Supported modes: ${manifest.supportedModes.join(', ')}.` },
    );
  }

  const templateRoot = options.registry.rootFor(manifest.id);
  const layers: { name: string; root: string }[] = [
    { name: 'base', root: path.join(templateRoot, 'base') },
    {
      name: `modes/${context.template.mode}`,
      root: path.join(templateRoot, 'modes', context.template.mode),
    },
  ];

  // Later layers override earlier ones, so collect in order and keep all hits.
  const byDestination = new Map<string, LayerFile[]>();
  for (const layer of layers) {
    for (const file of walkLayer(fs, layer.root, layer.name)) {
      const destination = renameSpecialPath(toPosix(file.rawRelativePath));
      const existing = byDestination.get(destination);
      if (existing) existing.push(file);
      else byDestination.set(destination, [file]);
    }
  }

  if (byDestination.size === 0) {
    throw new CliError(`Template "${manifest.id}" produced no files.`, {
      hint: 'The template directory appears to be empty or missing from the package.',
    });
  }

  const values = buildTokenValues(context, now);
  const operations: FileOperation[] = [];

  for (const [destination, contributions] of byDestination) {
    const last = contributions[contributions.length - 1];
    if (last === undefined) continue;

    if (!isTextFile(destination)) {
      // Binary assets are copied byte-for-byte and never token-substituted.
      operations.push({
        type: 'copy',
        path: destination,
        source: last.absolutePath,
        origin: last.layer,
      });
      continue;
    }

    const label = `${last.layer}/${last.rawRelativePath}`;
    let content: string;

    if (isMergeableJson(destination) && contributions.length > 1) {
      let merged: unknown;
      for (const contribution of contributions) {
        const parsed = parseJsonLayer(
          fs.readText(contribution.absolutePath),
          `${contribution.layer}/${contribution.rawRelativePath}`,
        );
        merged = merged === undefined ? parsed : deepMergeJson(merged, parsed);
      }
      content = stringifyJson(substituteInJson(merged, values, label));
    } else if (isMergeableJson(destination)) {
      const parsed = parseJsonLayer(fs.readText(last.absolutePath), label);
      content = stringifyJson(substituteInJson(parsed, values, label));
    } else {
      content = substituteTokens(normaliseEol(fs.readText(last.absolutePath)), values, label);
    }

    operations.push({
      type: 'write',
      path: destination,
      content: normaliseEol(content),
      origin: contributions.map((c) => c.layer).join(' + '),
    });
  }

  operations.push({
    type: 'write',
    path: PROVENANCE_FILE,
    content: stringifyJson(buildProvenance(context, manifest)),
    origin: 'cli',
  });

  operations.sort((a, b) => a.path.localeCompare(b.path));

  return {
    templateId: manifest.id,
    templateVersion: manifest.version,
    mode: context.template.mode,
    targetDir: context.targetDir,
    operations,
  };
}
