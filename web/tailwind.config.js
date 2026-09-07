/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx,astro}"],
  theme: {
    extend: {
      colors: {
        cyan: { 400: "var(--data)" },
        neon: {
          purple: "var(--accent)",
          pink: "var(--accent-hover)",
          blue: "var(--data)",
        },
        dark: {
          900: "var(--canvas)",
          800: "var(--surface)",
          700: "var(--surface-raised)",
          600: "var(--border)",
          500: "var(--border-strong)",
        },
        gray: {
          100: "var(--text)",
          200: "var(--text)",
          300: "var(--text-secondary)",
          400: "var(--text-secondary)",
          500: "var(--muted)",
          600: "var(--muted)",
        },
        green: { 400: "var(--positive)" },
        red: { 400: "var(--negative)" },
        amber: { 300: "var(--forecast)", 400: "var(--forecast)" },
      },
    },
  },
  plugins: [],
};
