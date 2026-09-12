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
    <div className="app-shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      {showHeader && <Header />}

      <main id="main" className="app-main">
        {children}
      </main>

      <Footer />
    </div>
  );
}
