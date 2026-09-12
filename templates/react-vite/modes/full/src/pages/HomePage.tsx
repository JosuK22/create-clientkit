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
      <Container className="intro">
        <div className="intro-inner">
          <h1 className="page-title">{SITE.name}</h1>
          <p className="lead">{SITE.description}</p>
          {CONTACT.email !== '' && (
            <a href={`mailto:${CONTACT.email}`} className="button-primary">
              Get in touch
            </a>
          )}
        </div>
      </Container>

      <Container className="sections">
        {SECTIONS.map((section) => (
          <section key={section.id} id={section.id} aria-labelledby={`${section.id}-heading`}>
            <h2 id={`${section.id}-heading`} className="section-title">
              {section.title}
            </h2>
            <p className="section-body">{section.body}</p>
          </section>
        ))}
      </Container>
    </BaseLayout>
  );
}
