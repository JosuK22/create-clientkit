import { CONTACT, NAV } from '../lib/site.config';

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
 * identical whether the project was generated with plain CSS or with Tailwind.
 *
 * Every optional piece is omitted rather than filled in: an empty
 * `CONTACT.email` renders no link, and an empty `NAV` renders no suggestions.
 */
export default function NotFound() {
  const links = NAV.filter((item) => item.label !== '' && item.href !== '');

  return (
    <div className="app-shell">
      <main className="app-main">
        <div className="container-page hero">
          <div className="hero-inner">
            <p className="eyebrow">404</p>

            <h1 className="page-title">This page doesn&apos;t exist.</h1>

            <p className="lead">
              The link may be out of date, or the address may have been mistyped.
            </p>

            <a href="/" className="button-primary">
              Return home
            </a>

            {CONTACT.email ? <a href={`mailto:${CONTACT.email}`}>Report a broken link</a> : null}

            {links.length > 0 ? (
              <nav aria-label="Other pages">
                <ul>
                  {links.map((item) => (
                    <li key={item.href}>
                      <a href={item.href}>{item.label}</a>
                    </li>
                  ))}
                </ul>
              </nav>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}
