/**
 * Design tokens (Z-14). Placeholder ramp — replaced when the design system lands.
 * Kept in sync with `@flower/config/tailwind`.
 */
export const tokens = {
  color: {
    brand: {
      50: '#fdf2f8',
      500: '#ec4899',
      600: '#db2777',
      900: '#831843',
    },
    fg: '#1b2320',
    bg: '#ffffff',
    danger: '#9c3b40',
  },
  radius: { card: '0.75rem', control: '0.5rem' },
  space: (n: number): string => `${n * 0.25}rem`,
} as const;

export type Tokens = typeof tokens;
