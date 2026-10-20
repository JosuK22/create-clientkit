import { CONTACT, SITE } from '../lib/site.config';
import { jsonLdScript, siteOrigin } from '../lib/seo';

/**
 * schema.org Organization data, built only from values configured in
 * `lib/site.config.ts`.
 *
 * Search engines consume structured data automatically, so a fabricated field
 * is worse than a missing one: every property below is omitted unless it has
 * a real value. No logo, address, social profile, rating or founding date is
 * invented.
 *
 * A server component, rendered into the page's markup so it is in the
 * response a crawler reads. The home page renders it; the not-found page
 * deliberately does not. Render `<StructuredData />` on any page you add that
 * should describe the organisation.
 */
export function StructuredData() {
  const origin = siteOrigin(SITE.url);
  const description = SITE.description.trim();
  const email = CONTACT.email.trim();
  const phone = CONTACT.phone.trim();

  const organization: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE.name,
  };

  if (origin !== '') organization['url'] = origin;
  if (description !== '') organization['description'] = description;
  if (email !== '') organization['email'] = email;
  if (phone !== '') organization['telephone'] = phone;

  return (
    <script
      type="application/ld+json"
      // Escaped for a script element: see jsonLdScript in lib/seo.ts.
      dangerouslySetInnerHTML={{ __html: jsonLdScript(organization) }}
    />
  );
}
