'use client';

import { Box, ChakraProvider, createSystem, defaultConfig } from '@chakra-ui/react';
import type { ReactNode } from 'react';

/**
 * Chakra UI, mounted above the application.
 *
 * ## Why the directive
 *
 * `ChakraProvider` is React context, so this file has to be part of the client
 * bundle. In a framework that renders the whole tree in the browser the
 * directive is a no-op; in one that renders on the server by default it is the
 * boundary that makes this component legal at all.
 *
 * Two things live here:
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

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ChakraProvider value={system}>
      <Box className="app-providers" colorPalette="gray">
        {children}
      </Box>
    </ChakraProvider>
  );
}
