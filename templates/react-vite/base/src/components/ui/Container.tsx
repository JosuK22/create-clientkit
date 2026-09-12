import type { ReactNode } from 'react';

interface ContainerProps {
  children: ReactNode;
  className?: string;
}

/**
 * The shared page gutter.
 *
 * Styled by the `container-page` class, which the selected styling system
 * defines. The markup names what a thing *is*, never how it looks - that is
 * what lets one component tree work under any styling system without the
 * framework template knowing which was chosen.
 */
export function Container({ children, className = '' }: ContainerProps) {
  return <div className={`container-page ${className}`.trim()}>{children}</div>;
}
