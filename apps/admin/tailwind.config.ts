import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#070c18', 900: '#0b1220', 800: '#111a2e', 700: '#1a2540', 600: '#27345a' },
        accent: { 50: '#eef4ff', 100: '#dbe6ff', 500: '#3b6cf6', 600: '#2a56e0', 700: '#2145bd' },
      },
      fontFamily: { sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'sans-serif'] },
      boxShadow: { card: '0 1px 2px rgba(15,23,42,.04), 0 1px 3px rgba(15,23,42,.06)', pop: '0 12px 32px rgba(15,23,42,.16)' },
      keyframes: {
        'fade-in': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'none' } },
        'slide-in': { from: { transform: 'translateX(100%)' }, to: { transform: 'none' } },
      },
      animation: { 'fade-in': 'fade-in .18s ease-out', 'slide-in': 'slide-in .2s ease-out' },
    },
  },
  plugins: [],
};
export default config;
