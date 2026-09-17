'use client';

import { Box, CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v16-appRouter';
import type { ReactNode } from 'react';

/**
 * Material UI, mounted above the application.
 *
 * ## Why the cache provider
 *
 * On a framework that renders on the server, Emotion generates styles during
 * that render and has nowhere to put them: they are emitted where the component
 * sits, which is inside `<body>`. React then hoists `<style>` into `<head>`
 * while hydrating, the two disagree, and every page load reports a recoverable
 * hydration error - with the production build reporting success throughout.
 *
 * `AppRouterCacheProvider` collects them and flushes them into the head before
 * the response is sent. It is only here because the framework can do that; the
 * client-only variant of this file has no cache provider and needs none.
 *
 * ## Why the directive
 *
 * `ThemeProvider` is React context and `createTheme` runs at module scope, so
 * this file has to be part of the client bundle. In a framework that renders
 * the whole tree in the browser the directive is a no-op - the bundler keeps
 * the string and nothing else changes. In one that renders on the server by
 * default it is the boundary that makes this component legal at all.
 *
 * One line, stated once, correct under both. The alternative was a second copy
 * of this file per framework, which is the per-combination template the whole
 * architecture exists to avoid.
 *
 * Three things have to be true for MUI components to behave anywhere in the
 * tree, and all three live here:
 *
 *   - `ThemeProvider` supplies the theme every MUI component reads. Without it
 *     components fall back to the default theme and any customisation below is
 *     silently ignored.
 *   - `CssBaseline` applies MUI's reset. It is scoped to MUI's own baseline and
 *     deliberately does not fight the global stylesheet - see the note below.
 *   - `Box` is an ordinary MUI component, rendered so the styling engine is
 *     exercised on a real element rather than only configured.
 *
 * ## MUI and your styling system are separate choices
 *
 * This file is contributed by the UI library you picked. The global stylesheet
 * is contributed by the styling system you picked, and neither knows about the
 * other. Utility and layout classes on the markup inside still apply normally;
 * MUI components are styled by this theme. That is the intended arrangement,
 * not an accident of ordering.
 *
 * If the two ever disagree about a specific element, prefer changing the theme
 * here over adding `!important` anywhere.
 *
 * ## Making it yours
 *
 * Edit `theme` below. Palette, typography and component defaults all belong
 * there, and everything under this provider picks them up. This file is yours
 * now - the generator will not touch it again.
 */

const theme = createTheme({
  // Deliberately close to MUI's defaults. A generated starter should not invent
  // a brand; set the palette once the client's colours are known.
  cssVariables: true,
});

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AppRouterCacheProvider>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Box className="app-providers">{children}</Box>
      </ThemeProvider>
    </AppRouterCacheProvider>
  );
}
