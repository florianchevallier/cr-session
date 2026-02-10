/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        parchment: {
          50: "#fdf8f0",
          100: "#f5ead6",
          200: "#eddcbc",
          300: "#e0c89a",
          400: "#d4b47a",
          500: "#c8a05c",
          600: "#b08940",
          700: "#8e6e33",
          800: "#6c5427",
          900: "#4a3a1b",
        },
      },
    },
  },
  plugins: [],
};
