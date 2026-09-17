/**
 * Tailwind v4 through PostCSS.
 *
 * The other half of the same plugin: a Vite project registers
 * `@tailwindcss/vite` in its build config instead, and neither project carries
 * the package it does not use.
 *
 * Nothing else belongs here. Autoprefixer is not needed - Tailwind v4 handles
 * vendor prefixing itself - and adding plugins speculatively is how a build
 * pipeline becomes something nobody can safely change.
 */
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
