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

  const large = size === 'lg';

  return (
    <span className="inline-flex items-center gap-3">
      <span
        aria-hidden="true"
        className={[
          'inline-flex items-center justify-center rounded-lg font-semibold',
          'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900',
          large ? 'h-12 w-12 text-lg' : 'h-8 w-8 text-sm',
        ].join(' ')}
      >
        {initials}
      </span>
      <span className={large ? 'text-xl font-semibold' : 'font-medium'}>{SITE.name}</span>
    </span>
  );
}
