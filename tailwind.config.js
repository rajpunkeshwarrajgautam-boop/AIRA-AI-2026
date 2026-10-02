/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        claude: {
          bg: {
            light: 'var(--bg-main)',
            dark: 'var(--bg-main)',
          },
          surface: {
            light: 'var(--bg-surface)',
            dark: 'var(--bg-surface)',
          },
          surface2: {
            light: 'var(--bg-surface-secondary)',
            dark: 'var(--bg-surface-secondary)',
          },
          border: {
            light: 'var(--border-color)',
            dark: 'var(--border-color)',
          },
          borderMuted: {
            light: 'var(--border-subtle)',
            dark: 'var(--border-subtle)',
          },
          text: {
            light: 'var(--text-primary)',
            dark: 'var(--text-primary)',
          },
          muted: {
            light: 'var(--text-muted)',
            dark: 'var(--text-muted)',
          },
          terracotta: {
            DEFAULT: 'var(--accent-terracotta)',
            hover: 'var(--accent-terracotta-hover)',
            light: 'rgba(124, 92, 255, 0.12)',
            dark: 'rgba(124, 92, 255, 0.25)',
          },
          amber: {
            DEFAULT: '#D97706',
            hover: '#B45309',
            light: '#FEF3C7',
          },
        },
      },
      fontFamily: {
        serif: ['Newsreader', 'Lora', 'Georgia', 'serif'],
        sans: ['Plus Jakarta Sans', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      boxShadow: {
        'claude-input': '0 0 0 1px rgba(45, 40, 30, 0.08), 0 2px 4px rgba(45, 40, 30, 0.02), 0 12px 28px -4px rgba(45, 40, 30, 0.06)',
        'claude-input-dark': '0 0 0 1px rgba(255, 255, 255, 0.08), 0 2px 6px rgba(0, 0, 0, 0.3), 0 16px 36px -6px rgba(0, 0, 0, 0.5)',
        'claude-card': '0 0 0 1px rgba(45, 40, 30, 0.06), 0 1px 3px rgba(45, 40, 30, 0.03)',
        'claude-card-hover': '0 0 0 1px rgba(124, 92, 255, 0.3), 0 4px 16px -2px rgba(45, 40, 30, 0.08)',
        'claude-popup': '0 0 0 1px rgba(45, 40, 30, 0.08), 0 20px 50px -10px rgba(0, 0, 0, 0.16)',
        'claude-popup-dark': '0 0 0 1px rgba(255, 255, 255, 0.1), 0 20px 50px -10px rgba(0, 0, 0, 0.6)',
      },
      keyframes: {
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        pulseSlow: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-4px)' },
        },
        sparkle: {
          '0%, 100%': { transform: 'scale(1) rotate(0deg)', opacity: '0.5' },
          '50%': { transform: 'scale(1.2) rotate(15deg)', opacity: '1' },
        },
        shimmerSweep: {
          '0%': { transform: 'translateX(-100%) rotate(30deg)' },
          '100%': { transform: 'translateX(200%) rotate(30deg)' },
        }
      },
      animation: {
        'shimmer': 'shimmer 2s infinite',
        'pulse-slow': 'pulseSlow 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.25s ease-out forwards',
        'slide-up': 'slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'scale-in': 'scaleIn 0.3s cubic-bezier(0.23, 1, 0.32, 1) forwards',
        'float': 'float 4s ease-in-out infinite',
        'sparkle': 'sparkle 1.5s ease-in-out infinite',
        'shimmer-sweep': 'shimmerSweep 3s ease-in-out infinite',
      }
    },
  },
  plugins: [],
}
