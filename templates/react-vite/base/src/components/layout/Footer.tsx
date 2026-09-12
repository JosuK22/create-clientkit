import { Container } from '../ui/Container';
import { CONTACT, SITE } from '../../config/site.config';

export function Footer() {
  // Built as one string rather than adjacent expressions in the markup, so a
  // formatter cannot split it and lose the space between year and name.
  const copyright = `© ${String(new Date().getFullYear())} ${SITE.name}`;
  const hasContact = CONTACT.email !== '' || CONTACT.phone !== '';

  return (
    <footer className="site-footer">
      <Container className="site-footer-inner">
        <p className="copyright">{copyright}</p>

        {hasContact && (
          <div className="contact-links">
            {CONTACT.email !== '' && (
              <a href={`mailto:${CONTACT.email}`} className="contact-link">
                {CONTACT.email}
              </a>
            )}
            {CONTACT.phone !== '' && (
              <a href={`tel:${CONTACT.phone.replace(/[^+0-9]/g, '')}`} className="contact-link">
                {CONTACT.phone}
              </a>
            )}
          </div>
        )}
      </Container>
    </footer>
  );
}
