/** @type {import('tailwindcss').Config} */
// Design tokens (navy/gold/cream palette, Spectral/Libre Franklin fonts) for the
// "premium B2B, not a hackathon project" look described in CLAUDE.md. The same
// hex values are duplicated as CSS custom properties in app/globals.css :root —
// keep both in sync by hand if a color changes (no shared source of truth).
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        navy: {
          DEFAULT: '#0B1F3B',
          light: '#142d52',
          dark: '#060f1d',
          muted: '#1e3a5f',
        },
        gold: {
          DEFAULT: '#C6A75E',
          light: '#d4bb7d',
          dark: '#a8893d',
          pale: '#f0e8d5',
        },
        cream: {
          DEFAULT: '#F7F9FC',
          dark: '#EEF1F6',
        },
        ink: {
          DEFAULT: '#1A2733',
          light: '#2E3F4F',
        },
        muted: '#5A6B7A',
        // Design tokens
        surface: '#FFFFFF',
        frame: '#DDE2E8',
        status: {
          success: '#2E7D52',
          warning: '#B45309',
          danger: '#BE3A2B',
        },
      },
      fontFamily: {
        display: ['var(--font-spectral)', 'Georgia', 'serif'],
        body: ['var(--font-libre-franklin)', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      letterSpacing: {
        'widest-2': '0.2em',
        'widest-3': '0.3em',
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-out forwards',
        'slide-up': 'slideUp 0.45s ease-out forwards',
        'spin-slow': 'spin 1.8s linear infinite',
        shimmer: 'shimmer 1.6s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(14px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(200%)' },
        },
      },
    },
  },
  plugins: [],
};
