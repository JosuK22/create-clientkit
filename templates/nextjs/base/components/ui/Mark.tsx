import { SITE } from '../../lib/site.config';

/**
 * A placeholder brand mark: the client's initials in a bordered square.
 *
 * Deliberately not an image. A generated project has no logo file, and shipping
 * a stand-in graphic would be something to find and delete later; initials read
 * as intentional until a real mark replaces them. Decorative, so it is hidden
 * from assistive technology - the name is already text on the page.
 */
export function Mark() {
  const initials = SITE.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();

  return (
    <div className="mark" aria-hidden="true">
      {initials || '—'}
    </div>
  );
}
