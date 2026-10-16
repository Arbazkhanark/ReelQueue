import type { Config } from 'tailwindcss';

/** Colors are CSS variables (see src/app/globals.css) so light/dark is a class swap. */
const token = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: token('bg'),
        surface: token('surface'),
        sunken: token('sunken'),
        ink: token('ink'),
        muted: token('muted'),
        line: token('line'),
        accent: token('accent'),
        'accent-ink': token('accent-ink'),
        ok: token('ok'),
        warn: token('warn'),
        danger: token('danger'),
        info: token('info'),
        sim: token('sim'),
      },
      fontFamily: {
        display: ['var(--font-display)'],
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      boxShadow: {
        card: '0 1px 0 rgb(var(--c-line) / 0.6), 0 8px 24px -16px rgb(0 0 0 / 0.25)',
      },
    },
  },
  plugins: [],
};

export default config;
