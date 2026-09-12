import { Container } from '../ui/Container';
import { CONTACT, SITE } from '../../config/site.config';

export function Footer() {
  // Built as one string rather than adjacent expressions in the markup, so a
  // formatter cannot split it and lose the space between year and name.
  const copyright = `© ${String(new Date().getFullYear())} ${SITE.name}`;
  const hasContact = CONTACT.email !== '' || CONTACT.phone !== '';

  return (
    <footer className="mt-auto border-t border-neutral-200 dark:border-neutral-800">
      <Container className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 py-8">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{copyright}</p>

        {hasContact && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
            {CONTACT.email !== '' && (
              <a
                href={`mailto:${CONTACT.email}`}
                className="inline-flex min-h-11 items-center text-sm text-neutral-500 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
              >
                {CONTACT.email}
              </a>
            )}
            {CONTACT.phone !== '' && (
              <a
                href={`tel:${CONTACT.phone.replace(/[^+0-9]/g, '')}`}
                className="inline-flex min-h-11 items-center text-sm text-neutral-500 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
              >
                {CONTACT.phone}
              </a>
            )}
          </div>
        )}
      </Container>
    </footer>
  );
}
