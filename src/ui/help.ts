import { PACKAGE_MANAGERS } from '../types.js';

export function helpText(): string {
  return `
  create-clientkit - the boring foundation of your next client website.

  Usage
    npm create clientkit@latest [directory] [options]
    npx create-clientkit@latest [directory] [options]

  Options
    -t, --template <id>   Template to scaffold from
        --list-templates  List available templates and exit
    -y, --yes             Accept all defaults; never prompt
        --from <file>     Read answers from a JSON config file
        --dry-run         Resolve and print the plan; write nothing
        --no-git          Skip git initialisation
        --no-install      Skip dependency installation
        --pm <manager>    Force a package manager (${PACKAGE_MANAGERS.join(' | ')})
        --debug           Print diagnostics and full stack traces
    -h, --help            Show this help
    -v, --version         Show the version

  Examples
    npm create clientkit@latest acme-website
    npm create clientkit@latest acme-website --yes --no-install
    npm create clientkit@latest --from ./agency-preset.json --dry-run

  Note
    Early build: configuration is resolved and validated, but no files are
    generated yet.
`.trimStart();
}
