import type { ReactNode } from 'react';

/**
 * The provider boundary, with nothing in it yet.
 *
 * The layout always wraps the application in this component, so that adding a
 * UI library later is a change to one file rather than a change to the layout's
 * shape. A project generated without one gets this pass-through: no context, no
 * client bundle, no behaviour.
 *
 * Deliberately a server component. There is nothing here that needs the
 * browser, and marking it `'use client'` would pull the whole subtree into the
 * client bundle to provide exactly nothing. The UI library that replaces this
 * file brings its own boundary when it needs one.
 *
 * This file is yours. Put application-wide context here - a session, a theme,
 * a feature flag provider - and add `'use client'` at the top if what you add
 * needs it.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
