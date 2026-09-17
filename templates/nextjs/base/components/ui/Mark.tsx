import { SITE } from '../../lib/site.config';

/**
 * A placeholder brand mark: the client's initials in a rounded square.
 *
 * Deliberately not an image. A generated project has no logo file, and shipping
 * a stand-in graphic would be something to find and delete later; initials read
 * as intentional until a real mark replaces them.
 *
 * The class names are the project's shared style contract - `brand`,
 * `brand-lg`, `brand-mark`, `brand-name` - which every styling system
 * implements. That is what lets this component render under plain CSS or
 * Tailwind without knowing which was selected.
 */
export function Mark({ size = 'lg' }: { size?: 'sm' | 'lg' }) {
  const initials = SITE.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();

  return (
    <span className={`brand brand-${size}`}>
      <span className="brand-mark" aria-hidden="true">
        {initials || '—'}
      </span>
      <span className="brand-name">{SITE.name}</span>
    </span>
  );
}
