import type { ReactNode } from 'react';

interface ContainerProps {
  children: ReactNode;
  className?: string;
}

/** The shared page gutter. One place to change the measure of the whole site. */
export function Container({ children, className = '' }: ContainerProps) {
  return <div className={`mx-auto w-full max-w-5xl px-6 ${className}`.trim()}>{children}</div>;
}
