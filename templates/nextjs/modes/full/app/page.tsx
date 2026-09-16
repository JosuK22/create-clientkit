import { Mark } from '../components/ui/Mark';
import { Section } from '../components/ui/Section';
import { CONTACT, SITE } from '../lib/site.config';

/**
 * Hero, About, Services, CTA, Footer - all server-rendered.
 *
 * No `'use client'` anywhere. Nothing on this page has state, effects or event
 * handlers, so nothing on it needs to become a client bundle. Adding an
 * interactive piece later is one directive on one component, which is exactly
 * why the boundary is worth not crossing by default.
 *
 * The copy is honest scaffolding: it says what the section is for rather than
 * pretending to describe a business nobody has told us about.
 */

const SERVICES = [
  {
    title: 'What you do',
    body: 'Replace this with the first thing a client actually hires you for.',
  },
  {
    title: 'How you do it',
    body: 'The part of your process that makes the result different.',
  },
  {
    title: 'What they get',
    body: 'The outcome, in the words a client would use to describe it.',
  },
];

export default function HomePage() {
  return (
    <>
      <main>
        <Section className="section">
          <Mark />
          <p className="eyebrow">{SITE.name}</p>
          <h1>{SITE.description || 'A short line about what you do.'}</h1>
          <p className="lede">
            Replace this paragraph with the one sentence a prospective client needs to read before
            they decide to keep reading.
          </p>
        </Section>

        <Section className="section" heading="About">
          <p className="lede">
            Who you are and why this work. Two or three sentences is usually enough - the rest
            belongs on a page of its own.
          </p>
        </Section>

        <Section className="section" heading="Services">
          <div className="grid">
            {SERVICES.map((service) => (
              <article className="card" key={service.title}>
                <h3>{service.title}</h3>
                <p>{service.body}</p>
              </article>
            ))}
          </div>
        </Section>

        <Section className="section" heading="Get in touch">
          <p className="lede">Tell them exactly what happens next and how long it takes.</p>
          {CONTACT.email ? (
            <p className="contact">
              <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>
            </p>
          ) : null}
        </Section>
      </main>

      <footer className="site-footer">
        <div className="container">
          <p>
            © {new Date().getFullYear()} {SITE.name}
            {SITE.author ? ` · ${SITE.author}` : ''}
          </p>
        </div>
      </footer>
    </>
  );
}
