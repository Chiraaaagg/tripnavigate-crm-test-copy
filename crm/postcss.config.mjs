// Tailwind CSS v4 through PostCSS, as the Next.js 16.3 CSS guide describes
// (node_modules/next/dist/docs/01-app/01-getting-started/11-css.md).
//
// A custom PostCSS config replaces Next.js's default PostCSS plugins
// (postcss-flexbugs-fixes, postcss-preset-env with autoprefixer). Next.js 16
// builds with Turbopack, which still runs Lightning CSS (transforms, vendor
// prefixes for the browser targets, minification) after PostCSS, and Tailwind
// runs its own Lightning CSS pass in production. Existing screens were proven
// pixel-identical in Chromium (dev and production builds, 9 October 2026).
// Safari and Firefox were not checked.
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
