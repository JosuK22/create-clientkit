import type { Logger } from '../ui/logger.js';
import type { TemplateRegistry } from '../templates/registry.js';
import { EXIT_OK } from '../errors.js';

export function runList(registry: TemplateRegistry, logger: Logger): number {
  const templates = registry.list();
  if (templates.length === 0) {
    logger.print('No templates are available yet.');
    return EXIT_OK;
  }
  logger.print('Available templates');
  for (const template of templates) {
    logger.print(`  ${template.id}  ${template.displayName} - ${template.description}`);
  }
  return EXIT_OK;
}
