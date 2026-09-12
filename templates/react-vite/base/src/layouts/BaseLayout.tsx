import type { ReactNode } from 'react';

import { Footer } from '../components/layout/Footer';
import { Header } from '../components/layout/Header';

interface BaseLayoutProps {
  children: ReactNode;
  /** Hide the header on pages that carry their own branding. */
  showHeader?: boolean;
}

/**
 * The shared shell: skip link, header, main, footer.
 *
 * Every page renders inside this, so the landmarks and the skip target are
 * defined once rather than per page.
 */
export function BaseLayout({ children, showHeader = true }: BaseLayoutProps) {
  return (
    <div className="flex min-h-dvh flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-neutral-900 focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>

      {showHeader && <Header />}

      <main id="main" className="flex-1">
        {children}
      </main>

      <Footer />
    </div>
  );
}
