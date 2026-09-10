import { EXIT_OK } from '../errors.js';
import type { TemplateRegistry } from '../templates/registry.js';
import type { Logger } from '../ui/logger.js';

export function runList(registry: TemplateRegistry, logger: Logger): number {
  const templates = registry.list();
  if (templates.length === 0) {
    logger.print('No templates are available yet.');
    return EXIT_OK;
  }

  logger.print('Available templates:');
  for (const template of templates) {
    logger.print('');
    logger.print(`  ${template.id}`);
    logger.print(`  ${template.displayName}`);
    logger.print(`  ${template.description}`);
    logger.print(`  modes: ${template.modes.join(', ')}`);
  }
  return EXIT_OK;
}
