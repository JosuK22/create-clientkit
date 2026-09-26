'use client';

import { Box, ChakraProvider, createSystem, defaultConfig } from '@chakra-ui/react';
import createCache from '@emotion/cache';
import { CacheProvider } from '@emotion/react';
import { useServerInsertedHTML } from 'next/navigation';
import { useState, type ReactNode } from 'react';

/**
 * Chakra UI, mounted above the application.
 *
 * ## Why the style cache
 *
 * On a framework that renders on the server, Emotion - Chakra's styling engine
 * - generates styles during that render and has nowhere to put them: they are
 * emitted where the component sits, which is inside `<body>`. The browser's
 * first render then disagrees with the server's markup, and every page load
 * reports a hydration error - with the production build reporting success
 * throughout.
 *
 * The cache below collects those styles instead, and `useServerInsertedHTML`
 * flushes them into the head before the response is sent. It is only here
 * because the framework can do that; the client-only variant of this file has
 * no cache and needs none.
 *
 * ## Why the directive
 *
 * `ChakraProvider` is React context, so this file has to be part of the client
 * bundle. In a framework that renders on the server by default it is the
 * boundary that makes this component legal at all.
 *
 * Two things live here, inside the cache:
 *
 *   - `ChakraProvider` supplies the styling system every Chakra component
 *     reads. Without it Chakra components throw rather than render.
 *   - `Box` is an ordinary Chakra component, rendered so the styling engine is
 *     exercised on a real element rather than only configured. Its
 *     `colorPalette` is the accent every Chakra component below inherits -
 *     `gray` is Chakra's own default, so change it here to recolour them all.
 *
 * ## Chakra and your styling system are separate choices
 *
 * This file is contributed by the UI library you picked. The global stylesheet
 * is contributed by the styling system you picked, and it already resets the
 * browser's defaults. Chakra's own reset (`preflight`) is therefore turned off
 * below: it lives in a CSS layer declared after your styling system's, so left
 * on it would override your utility classes - every margin and padding among
 * them. Chakra's components carry their own styles and do not depend on it.
 *
 * ## Making it yours
 *
 * Extend `system` below with `theme.tokens`, `theme.semanticTokens` or
 * `theme.recipes`, and everything under this provider picks them up. This file
 * is yours now - the generator will not touch it again.
 */

const system = createSystem(defaultConfig, {
  preflight: false,
});

function StyleCache({ children }: { children: ReactNode }) {
  const [{ cache, flush }] = useState(() => {
    const cache = createCache({ key: 'css' });
    // Keeps rules in the cache during a server render instead of emitting
    // them inline, so they can be flushed into the head below.
    cache.compat = true;
    const insert = cache.insert;
    let pending: string[] = [];
    cache.insert = (...args) => {
      const serialized = args[1];
      if (cache.inserted[serialized.name] === undefined) pending.push(serialized.name);
      return insert(...args);
    };
    const flush = () => {
      const names = pending;
      pending = [];
      return names;
    };
    return { cache, flush };
  });

  useServerInsertedHTML(() => {
    const names = flush();
    if (names.length === 0) return null;
    let styles = '';
    for (const name of names) {
      const rules = cache.inserted[name];
      if (typeof rules === 'string') styles += rules;
    }
    return (
      <style
        key={cache.key}
        data-emotion={`${cache.key} ${names.join(' ')}`}
        dangerouslySetInnerHTML={{ __html: styles }}
      />
    );
  });

  return <CacheProvider value={cache}>{children}</CacheProvider>;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <StyleCache>
      <ChakraProvider value={system}>
        <Box className="app-providers" colorPalette="gray">
          {children}
        </Box>
      </ChakraProvider>
    </StyleCache>
  );
}
