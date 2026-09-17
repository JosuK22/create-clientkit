import type { Metadata } from 'next';

import { AppProviders } from '../components/providers/AppProviders';
import { SITE } from '../lib/site.config';
import '../styles/globals.css';

/**
 * The root layout: the top of the tree, and the only place `<html>` exists.
 *
 * A server component, deliberately, and it stays one. Nothing here needs state,
 * effects or browser APIs, so nothing here needs to reach the browser as
 * JavaScript - and marking this file `'use client'` would pull every page under
 * it into the client bundle to solve a problem it does not have.
 *
 * ## The provider boundary
 *
 * `AppProviders` is always here, whether or not anything fills it. A project
 * with no UI library gets a pass-through that renders its children and nothing
 * else; a project with one gets that library's providers instead, at the same
 * place, without this file changing. Where the client boundary goes - if one is
 * needed at all - is that component's decision, which is what keeps it out of
 * this one.
 *
 * `metadata` is baseline only - a title and a description taken from the one
 * config file. There is no canonical URL, no Open Graph block and no social
 * card, because those need a production URL and a considered decision per page,
 * and inventing either would put claims in the head that nobody made.
 */
export const metadata: Metadata = {
  title: SITE.name,
  description: SITE.description,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={SITE.locale || 'en'}>
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
