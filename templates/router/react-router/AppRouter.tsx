import { BrowserRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';

/**
 * The application's routes.
 *
 * One route, deliberately. A scaffold that shipped `/about`, `/contact` and
 * `/dashboard` would be handing you three pages to delete before you could
 * start, and every one of them would be a guess about a site nobody has
 * designed yet. What is here is the wiring: a router mounted above the
 * application, with the home page as its first route.
 *
 * ## Adding a route
 *
 * Import a page and add a `<Route>` beside the one below:
 *
 *     <Route path="/about" element={<AboutPage />} />
 *
 * ## About the not-found case
 *
 * You can add a catch-all with `path="*"`, and it will render for any address
 * the routes above do not match. Worth knowing what that is and is not: it
 * renders a component in the browser *after* the server has already answered,
 * so the response itself is still whatever your host sent - usually a 200 for
 * `index.html`. Crawlers and monitoring see that status, not a 404.
 *
 * A real not-found response needs the host to serve one, or a framework that
 * renders on the server. This file cannot produce it, so it does not pretend
 * to. See the README before relying on client-side fallbacks for SEO.
 *
 * This file is yours now - the generator will not touch it again.
 */
export function AppRouter({ children }: { children: ReactNode }) {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={children} />
      </Routes>
    </BrowserRouter>
  );
}
