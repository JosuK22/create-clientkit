import { Container } from '../components/ui/Container';
import { BaseLayout } from '../layouts/BaseLayout';
import { useDocumentMeta } from '../hooks/useDocumentMeta';
import { CONTACT, SITE } from '../config/site.config';

/** Placeholder structure, not placeholder claims - replace the copy, keep the shape. */
const SECTIONS = [
  {
    id: 'about',
    title: 'About',
    body: 'Introduce the business here: who they are, who they serve, and what makes the work worth choosing.',
  },
  {
    id: 'work',
    title: 'Work',
    body: 'Show the work. Case studies, projects or services - whichever tells the clearest story.',
  },
  {
    id: 'contact',
    title: 'Contact',
    body: 'Make the next step obvious. One clear way to get in touch beats five competing options.',
  },
];

export function HomePage() {
  useDocumentMeta(SITE.name, SITE.description);

  return (
    <BaseLayout>
      <Container className="py-20">
        <div className="max-w-2xl">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">{SITE.name}</h1>
          <p className="mt-5 text-lg leading-relaxed text-neutral-600 dark:text-neutral-400">
            {SITE.description}
          </p>
          {CONTACT.email !== '' && (
            <a
              href={`mailto:${CONTACT.email}`}
              className="mt-8 inline-flex min-h-11 items-center rounded-lg bg-neutral-900 px-5 text-sm font-medium text-white transition-colors hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              Get in touch
            </a>
          )}
        </div>
      </Container>

      <Container className="grid gap-10 border-t border-neutral-200 py-16 sm:grid-cols-3 dark:border-neutral-800">
        {SECTIONS.map((section) => (
          <section key={section.id} id={section.id} aria-labelledby={`${section.id}-heading`}>
            <h2 id={`${section.id}-heading`} className="text-lg font-semibold">
              {section.title}
            </h2>
            <p className="mt-3 leading-relaxed text-neutral-600 dark:text-neutral-400">
              {section.body}
            </p>
          </section>
        ))}
      </Container>
    </BaseLayout>
  );
}
