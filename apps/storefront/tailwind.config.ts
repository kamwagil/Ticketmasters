import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Set per request from the brand returned by the central API (see app/layout.tsx).
        brand: { DEFAULT: 'var(--brand)', fg: 'var(--brand-fg)', accent: 'var(--accent)', 'accent-fg': 'var(--accent-fg)', ink: 'var(--brand-ink)' },
      },
    },
  },
  plugins: [],
};
export default config;
