import localFont from 'next/font/local';

/**
 * Inter, the Lagoon brand typeface, self-hosted from files in this repository
 * (no network at build time; served from this origin, font-src 'self').
 *
 * Source: npm package @fontsource-variable/inter 5.3.0 (registry tarball,
 * integrity checked by npm), which repackages Google Fonts' Inter v20
 * (github.com/google/fonts, last modified 2025-09-10). Licence: SIL Open Font
 * License 1.1, copied to src/fonts/inter/Inter-OFL-1.1.txt.
 *   inter-latin-wght-normal.woff2      sha256 3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62
 *   inter-latin-ext-wght-normal.woff2  sha256 34b9c504cab7a73e37b746343a449132e56cf7b5481af2cb81dc74dcff25c956
 *
 * Two faces with the subsets' unicode ranges, so a page downloads the
 * extended file only when it shows such a character (the rupee sign, U+20B9,
 * is in latin-ext). tokens.css lists both variables in --font-sans.
 *
 * Only the CSS variables are used. Never use `.style`: it renders a style
 * attribute, which the production Content Security Policy blocks.
 *
 * The latin face is preloaded (lead decision, 9 October 2026, because every
 * staff page shows the Lagoon frame). The font is set up in the ROOT layout,
 * so the preload link is sent on EVERY route, including sign-in and the other
 * public pages that do not use Inter yet. The latin-ext face is not preloaded;
 * the browser fetches it only for a character in its range (for example the
 * rupee sign).
 */
export const inter = localFont({
  src: '../fonts/inter/inter-latin-wght-normal.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-inter',
  preload: true,
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
    },
  ],
});

export const interExtended = localFont({
  src: '../fonts/inter/inter-latin-ext-wght-normal.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-inter-ext',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
    },
  ],
});
