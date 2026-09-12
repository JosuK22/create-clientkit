import { Brand } from '../common/Brand';
import { Container } from '../ui/Container';
import { NAV } from '../../config/site.config';

/**
 * Site header.
 *
 * The menu is omitted entirely when NAV is empty - a bar containing one logo
 * that links nowhere is worse than no bar.
 */
export function Header() {
  const links = NAV.filter((item) => item.label !== '' && item.href !== '');

  return (
    <header className="border-b border-neutral-200 dark:border-neutral-800">
      <Container className="flex flex-wrap items-center justify-between gap-4 py-4">
        <Brand />

        {links.length > 0 && (
          <nav aria-label="Primary">
            <ul className="flex flex-wrap items-center gap-x-6 gap-y-2">
              {links.map((item) => (
                <li key={item.href}>
                  <a
                    href={item.href}
                    className="inline-flex min-h-11 items-center text-sm font-medium text-neutral-600 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </Container>
    </header>
  );
}
