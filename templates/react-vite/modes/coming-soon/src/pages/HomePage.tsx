import { Brand } from '../components/common/Brand';
import { Container } from '../components/ui/Container';
import { BaseLayout } from '../layouts/BaseLayout';
import { useDocumentMeta } from '../hooks/useDocumentMeta';
import { CONTACT, SITE } from '../config/site.config';

/**
 * The launch page.
 *
 * No header: the brand and the status sit in a quiet bar of their own, and a
 * launch page has nowhere to navigate to yet. The footer still comes from the
 * layout, so the copyright and any contact details appear as on every page.
 *
 * The headline and the line under it are page copy - edit them here. The site
 * description stays in the document's meta description, where search engines
 * and link previews read it. The button appears only once `CONTACT.email` is
 * set; there is no form, because there is nowhere for one to send to.
 */
export function HomePage() {
  useDocumentMeta(SITE.name, SITE.description);

  return (
    <BaseLayout showHeader={false}>
      <div className="notice">
        <Container className="notice-bar">
          <Brand />
          <p className="status-label">Coming soon</p>
        </Container>

        <Container className="notice-body">
          <span className="notice-rule" aria-hidden="true" />

          <h1 className="notice-title">Something great is on the way.</h1>

          <p className="notice-lead">
            We&apos;re putting the finishing touches on our new website. Stay tuned.
          </p>

          {CONTACT.email !== '' && (
            <div className="notice-actions">
              <a href={`mailto:${CONTACT.email}`} className="button-primary">
                Contact us
              </a>
            </div>
          )}
        </Container>
      </div>
    </BaseLayout>
  );
}
