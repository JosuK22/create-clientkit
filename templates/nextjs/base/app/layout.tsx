import type { Metadata } from 'next';

import { SITE } from '../lib/site.config';
import '../styles/globals.css';

/**
 * The root layout: the top of the tree, and the only place `<html>` exists.
 *
 * A server component, deliberately. Nothing here needs state, effects or
 * browser APIs, so nothing here needs to reach the browser as JavaScript.
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
      <body>{children}</body>
    </html>
  );
}
