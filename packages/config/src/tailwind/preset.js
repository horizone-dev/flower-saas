/**
 * @flower/config/tailwind — shared Tailwind preset for all four web apps and
 * `packages/ui` (Z-14: one design system). Tailwind v4.
 *
 * Usage (Tailwind v4 CSS-first): import the token layer in your app CSS, or
 * reference this preset from `tailwind.config.js` where a JS config is still used.
 */

/** @type {import('tailwindcss').Config} */
const preset = {
  theme: {
    extend: {
      colors: {
        // Placeholder brand ramp — replaced when the design system lands (Z-14).
        brand: {
          50: '#fdf2f8',
          100: '#fce7f3',
          200: '#fbcfe8',
          300: '#f9a8d4',
          400: '#f472b6',
          500: '#ec4899',
          600: '#db2777',
          700: '#be185d',
          800: '#9d174d',
          900: '#831843',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        card: '0.75rem',
      },
    },
  },
  // RTL support (§45): apps enable the logical-properties plugin when added.
  plugins: [],
};

export default preset;
