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
      <Container className="flex min-h-[70vh] flex-col justify-center py-20">
        <div className="max-w-2xl">
          <Brand size="lg" />

          <p className="mt-10 text-sm font-medium uppercase tracking-widest text-neutral-500 dark:text-neutral-400">
            Coming soon
          </p>

          <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">{SITE.name}</h1>

          <p className="mt-5 text-lg leading-relaxed text-neutral-600 dark:text-neutral-400">
            {SITE.description}
          </p>

          {CONTACT.email !== '' && (
            <a
              href={`mailto:${CONTACT.email}`}
              className="mt-10 inline-flex min-h-11 items-center rounded-lg bg-neutral-900 px-5 text-sm font-medium text-white transition-colors hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              Get in touch
            </a>
          )}
        </div>
      </Container>
    </BaseLayout>
  );
}
