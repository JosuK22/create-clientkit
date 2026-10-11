import { Mark } from '../components/ui/Mark';
import { CONTACT, SITE } from '../lib/site.config';

/**
 * The launch page.
 *
 * A server component with no interactivity at all: no countdown, no form, no
 * client bundle. A countdown in particular is a promise with a date attached,
 * and a launch page that silently passes its own deadline is worse than one
 * that never made the claim.
 *
 * The headline and the line under it are page copy - edit them here. The site
 * description stays in the layout's metadata, where search engines and link
 * previews read it.
 *
 * Every optional piece is omitted rather than filled with a placeholder - an
 * empty `CONTACT.email` renders no button, not `hello@example.com`.
 *
 * The class names are the shared style contract, so this markup is identical
 * whether the project was generated with plain CSS, Tailwind or Bootstrap.
 */
export default function HomePage() {
  // One string, so a formatter cannot split it and lose the space.
  const copyright = `© ${String(new Date().getFullYear())} ${SITE.name}`;

  return (
    <div className="app-shell">
      <main className="app-main">
        <div className="notice">
          <div className="container-page notice-bar">
            <Mark size="sm" />
            <p className="status-label">Coming soon</p>
          </div>

          <div className="container-page notice-body">
            <span className="notice-rule" aria-hidden="true" />

            <h1 className="notice-title">Something great is on the way.</h1>

            <p className="notice-lead">
              We&apos;re putting the finishing touches on our new website. Stay tuned.
            </p>

            {CONTACT.email ? (
              <div className="notice-actions">
                <a href={`mailto:${CONTACT.email}`} className="button-primary">
                  Contact us
                </a>
              </div>
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
