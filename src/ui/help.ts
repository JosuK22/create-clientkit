import { createAdapterRegistry } from '../adapters/registry.js';
import { PRESETS } from '../context/presets.js';
import { findTemplatesRoot } from '../templates/registry.js';
import { PACKAGE_MANAGERS } from '../types.js';

/**
 * The listed values are read from the registry, never typed here.
 *
 * A hand-written list is a second source of truth, and the failure mode is
 * specific and bad: help that advertises an adapter which does not exist, or
 * omits one that does. The domain vocabulary knows `angular` and `chakra`; the
 * registry knows what is actually implemented, and that is what a user needs
 * printed. The distinction is spelled out in the Notes so nobody reads a short
 * list as the limit of the design.
 */
interface SupportedIds {
  frameworks: string;
  styling: string;
  uiLibraries: string;
  routers: string;
  features: string;
}

/**
 * Reading the registry means touching the filesystem, and `--help` is the one
 * command that has to work when something is wrong.
 *
 * A broken install fails every other command loudly; help should still print.
 * So a failure here degrades to "see --list-templates" rather than to a
 * hard-coded list - a guess would be the one outcome worse than saying nothing,
 * because it could name an adapter that is not there.
 */
const UNKNOWN = '(run --debug for details)';

function supported(): SupportedIds {
  try {
    const adapters = createAdapterRegistry(findTemplatesRoot());
    return {
      frameworks: adapters.implementedFrameworks().join(' | '),
      // `none` is a real answer rather than a missing adapter, so it belongs in
      // the list even though the registry has nothing to return for it.
      styling: [...adapters.implementedStyling(), 'none'].join(' | '),
      uiLibraries: [...adapters.implementedUiLibraries(), 'none'].join(' | '),
      routers: [...adapters.implementedRouters(), 'none', 'file-based'].join(' | '),
      features: adapters.implementedFeatures().join(', '),
    };
  } catch {
    return {
      frameworks: UNKNOWN,
      styling: UNKNOWN,
      uiLibraries: UNKNOWN,
      routers: UNKNOWN,
      features: UNKNOWN,
    };
  }
}

/**
 * The preset list, from the registry.
 *
 * Read rather than written for the reason every other list here is: a
 * hand-maintained copy would eventually advertise a preset that does not exist,
 * or omit one that does. A test asserts every advertised id resolves.
 */
function presetRows(): string {
  const presets = PRESETS.all();
  const width = Math.max(...presets.map((preset) => preset.id.length));
  return presets
    .map((preset) => `      ${preset.id.padEnd(width)}  ${preset.displayName}`)
    .join('\n');
}

export function helpText(): string {
  const ids = supported();

  return `
  create-clientkit - the boring foundation of your next client website.

  Usage
    npm create clientkit@latest [directory] [options]
    npx create-clientkit@latest [directory] [options]

    Run it with nothing and it asks. Every question below has a flag, and a
    flag you pass is a question you are not asked. A JSON file passed with
    --from can supply the same answers, and a flag still beats the file.

  Options
        --name <name>     Client / site name
        --url <url>       Production URL (omit if not decided yet)
    -m, --mode <mode>     coming-soon | full
    -y, --yes             Accept all defaults; never prompt
        --from <file>     Read answers from a JSON config file (see README)
        --dry-run         Resolve and print the plan; write nothing
        --no-git          Skip git initialisation
        --no-install      Skip dependency installation
        --pm <manager>    Force a package manager (${PACKAGE_MANAGERS.join(' | ')})
        --debug           Print diagnostics, stack traces, and where each
                          resolved value came from
    -h, --help            Show this help
    -v, --version         Show the version

  Presets
    A named starting point. Everything it sets can still be overridden by the
    flags below, and anything it leaves out resolves exactly as it would have.
    Configure part of the stack and a preset will fill the rest - interactively,
    only presets that can still contribute something are offered.

        --preset <id>     Start from one of these:

${presetRows()}

  Stack
    Each flag configures one dimension. Anything you leave out is asked for
    interactively, or - when there is only one possible answer - chosen for
    you by the framework that owns it.

        --framework <id>      ${ids.frameworks}  (default: astro)
        --build-tool <id>     chosen by the framework unless it offers you one
        --language <id>       ts  (typescript also accepted; every framework fixes it)
        --styling <id>        ${ids.styling}  (default: tailwind)
        --ui-library <id>     ${ids.uiLibraries}  (default: none)
        --router <id>         ${ids.routers}
        --architecture <id>   chosen by the framework
        --features <a,b>      ${ids.features}

  Legacy
    -t, --template <id>   Scaffold from a named template
        --list-templates  List available templates and exit

    --template names a whole stack, so it cannot be combined with the Stack
    flags above. Use one or the other.

  Examples
    npm create clientkit@latest
    npm create clientkit@latest acme-website
    npm create clientkit@latest acme-website --yes --no-install
    npm create clientkit@latest --from ./agency-preset.json --dry-run
    npm create clientkit@latest --from ./clientkit.json --yes

    npm create clientkit@latest acme-app --preset react-mui
    npm create clientkit@latest acme-app --preset react-tailwind --ui-library mui

    npm create clientkit@latest acme-app \\
      --framework react --build-tool vite --language typescript \\
      --styling tailwind --ui-library mui --router react-router

  Notes
    A config file describes the same project the flags do. Its "stack" block
    takes the dimension names below without their dashes, every field is
    optional, and anything it leaves out is asked for or defaulted exactly as
    it would be otherwise.

    Only questions worth asking are asked. A dimension with one possible answer
    is derived rather than offered as a menu of one, and a choice that cannot be
    built with what you have already picked is not shown - Bootstrap does not
    appear under Astro, and a client-side fallback appears only once a router
    does.

    The values listed above are the ones that work today. ClientKit's vocabulary
    is wider - it knows names such as angular and chakra - and asking for one of
    those reports that no adapter implements it rather than quietly substituting
    something else.

    Not every combination is buildable, and ClientKit checks rather than
    guesses. An impossible stack is refused before anything is written, with the
    reason named: React has no way to put metadata in the document before the
    response is sent, so --features seo is refused there.

    Dependencies are installed and a git repository is initialised by default.
    Pass --no-install or --no-git to skip either.

    The generated project is yours - private, unlicensed and dependency-pinned.
    Nothing phones home and nothing is downloaded beyond your own install.
`.trimStart();
}
