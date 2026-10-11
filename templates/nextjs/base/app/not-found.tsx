import Link from 'next/link';

import { Mark } from '../components/ui/Mark';
import { CONTACT, NAV, SITE } from '../lib/site.config';

/**
 * The not-found page.
 *
 * Next renders this for any path that matches no route, at any depth and
 * including paths under pages you add later - the framework resolves it, so
 * there is no list of routes here and nothing to keep in step as the site
 * grows.
 *
 * A server component with no interactivity, like every other page this template
 * ships. The class names are the shared style contract, so this markup is
 * identical whether the project was generated with plain CSS, Tailwind or
 * Bootstrap.
 *
 * Every optional piece is omitted rather than filled in: an empty
 * `CONTACT.email` renders no link, and an empty `NAV` renders no suggestions.
 */
export default function NotFound() {
  const links = NAV.filter((item) => item.label !== '' && item.href !== '');
  // One string, so a formatter cannot split it and lose the space.
  const copyright = `© ${String(new Date().getFullYear())} ${SITE.name}`;

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="container-page site-header-inner">
          <Link href="/" className="brand-link">
            <Mark size="sm" />
          </Link>
        </div>
      </header>

      <main className="app-main">
        <div className="notice">
          <div className="container-page notice-body">
            {/* Decorative: the heading below carries the meaning. */}
            <p className="notice-code" aria-hidden="true">
              404
            </p>

            <h1 className="notice-title">Page not found</h1>

            <p className="notice-lead">
              The page you&apos;re looking for may have moved, or the link may have been mistyped.
            </p>

            <div className="notice-actions">
              <Link href="/" className="button-primary">
                Back to home
              </Link>
              {CONTACT.email ? (
                <a href={`mailto:${CONTACT.email}`} className="notice-link">
                  Report a broken link
                </a>
              ) : null}
            </div>

            {links.length > 0 ? (
              <nav className="notice-links" aria-label="Other pages">
                <ul>
                  {links.map((item) => (
                    <li key={item.href}>
                      <a href={item.href} className="notice-link">
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            ) : null}
          </div>
        </div>
      </main>

      <footer className="site-footer">
        <div className="container-page site-footer-inner">
          <p className="copyright">{copyright}</p>
        </div>
      </footer>
    </div>
  );
}
