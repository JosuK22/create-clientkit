import { Mark } from '../components/ui/Mark';
import { Section } from '../components/ui/Section';
import { CONTACT, SITE } from '../lib/site.config';

/**
 * Hero, sections, CTA and footer - all server-rendered.
 *
 * No `'use client'` anywhere. Nothing on this page has state, effects or event
 * handlers, so nothing on it needs to become a client bundle. Adding an
 * interactive piece later is one directive on one component, which is exactly
 * why the boundary is worth not crossing by default.
 *
 * The copy is honest scaffolding: it says what the section is for rather than
 * pretending to describe a business nobody has told us about. The class names
 * are the shared style contract, so the same markup renders under plain CSS or
 * Tailwind.
 */

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

export default function HomePage() {
  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="container-page site-header-inner">
          <Mark size="sm" />
        </div>
      </header>

      <main className="app-main">
        <div className="container-page intro">
          <div className="intro-inner">
            <h1 className="page-title">{SITE.name}</h1>
            {SITE.description ? <p className="lead">{SITE.description}</p> : null}
            {CONTACT.email ? (
              <a href={`mailto:${CONTACT.email}`} className="button-primary">
                Get in touch
              </a>
            ) : null}
          </div>
        </div>

        <div className="container-page sections">
          {SECTIONS.map((entry) => (
            <Section key={entry.id} id={entry.id} title={entry.title} body={entry.body} />
          ))}
        </div>
      </main>

      <footer className="site-footer">
        <div className="container-page site-footer-inner">
          <p className="copyright">
            © {new Date().getFullYear()} {SITE.name}
            {SITE.author ? ` · ${SITE.author}` : ''}
          </p>
          {CONTACT.email ? (
            <div className="contact-links">
              <a href={`mailto:${CONTACT.email}`} className="contact-link">
                {CONTACT.email}
              </a>
            </div>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
