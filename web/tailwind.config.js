/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx,astro}"],
  theme: {
    extend: {
      colors: {
        neon: {
          purple: "#B026FF",
          pink: "#FF2D95",
          blue: "#00D4FF",
        },
        dark: {
          900: "#0a0a0f",
          800: "#12121a",
          700: "#1a1a24",
          600: "#24242f",
        },
      },
    },
  },
  plugins: [],
};
