import { Mark } from '../components/ui/Mark';
import { CONTACT, SITE } from '../lib/site.config';

/**
 * One page, centred, and nothing that needs JavaScript.
 *
 * A server component with no interactivity at all: no countdown, no form, no
 * client bundle. A countdown in particular is a promise with a date attached,
 * and a launch page that silently passes its own deadline is worse than one
 * that never made the claim.
 *
 * Every optional piece is omitted rather than filled with a placeholder - an
 * empty `CONTACT.email` renders nothing, not `hello@example.com`.
 */
export default function HomePage() {
  return (
    <main className="centered">
      <Mark />

      <p className="eyebrow">Coming soon</p>

      <h1>{SITE.name}</h1>

      {SITE.description ? <p className="lede">{SITE.description}</p> : null}

      {CONTACT.email ? (
        <p className="contact">
          <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>
        </p>
      ) : null}
    </main>
  );
}
