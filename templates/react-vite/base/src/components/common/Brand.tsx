import { SITE } from '../../config/site.config';

interface BrandProps {
  /** 'lg' is the hero lockup; 'sm' sits in the header. */
  size?: 'sm' | 'lg';
}

/** Initials mark plus wordmark, derived from the site name. */
export function Brand({ size = 'sm' }: BrandProps) {
  const initials = SITE.name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();

  return (
    <span className={`brand brand-${size}`}>
      <span aria-hidden="true" className="brand-mark">
        {initials}
      </span>
      <span className="brand-name">{SITE.name}</span>
    </span>
  );
}
