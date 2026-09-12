import { Brand } from '../components/common/Brand';
import { Container } from '../components/ui/Container';
import { BaseLayout } from '../layouts/BaseLayout';
import { useDocumentMeta } from '../hooks/useDocumentMeta';
import { CONTACT, SITE } from '../config/site.config';

/**
 * The launch page.
 *
 * No header: the page carries its own brand lockup below, and repeating it in
 * a bar would say the same thing twice on one screen. A launch page also has
 * nowhere to navigate to yet.
 */
export function HomePage() {
  useDocumentMeta(SITE.name, SITE.description);

  return (
    <BaseLayout showHeader={false}>
      <Container className="hero">
        <div className="hero-inner">
          <Brand size="lg" />

          <p className="eyebrow">Coming soon</p>

          <h1 className="page-title">{SITE.name}</h1>

          <p className="lead">{SITE.description}</p>

          {CONTACT.email !== '' && (
            <a href={`mailto:${CONTACT.email}`} className="button-primary">
              Get in touch
            </a>
          )}
        </div>
      </Container>
    </BaseLayout>
  );
}
