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
 * Every optional piece is omitted rather than filled with a placeholder - an
 * empty `CONTACT.email` renders nothing, not `hello@example.com`.
 *
 * The class names are the shared style contract, so this markup is identical
 * whether the project was generated with plain CSS or with Tailwind.
 */
export default function HomePage() {
  return (
    <div className="app-shell">
      <main className="app-main">
        <div className="container-page hero">
          <div className="hero-inner">
            <Mark />

            <p className="eyebrow">Coming soon</p>

            <h1 className="page-title">{SITE.name}</h1>

            {SITE.description ? <p className="lead">{SITE.description}</p> : null}

            {CONTACT.email ? (
              <a href={`mailto:${CONTACT.email}`} className="button-primary">
                Get in touch
              </a>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}
