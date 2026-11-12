/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Map extracted palette directly into the scales used across the app
        neutral: {
          950: "#09090B", // Primary background
          900: "#121215", // Sidebar background
          850: "#141417", // Card / surface
          800: "#27272A", // Borders / separators
          750: "#18181B", // Surface hover
          700: "#3F3F47", // Secondary border / strong
          600: "#52525B",
          500: "#71717A", // Muted text
          400: "#A1A1AA", // Secondary text
          300: "#D4D4D8",
          200: "#E4E4E7",
          100: "#F4F4F5", // Primary text
          50:  "#FAFAFA",
        },
        zinc: {
          950: "#09090B",
          900: "#121215",
          850: "#141417",
          800: "#27272A",
          700: "#3F3F47",
          500: "#71717A",
          400: "#A1A1AA",
          100: "#F4F4F5",
        },
        emerald: {
          400: "#00D492", // Primary accent green
          500: "#00BC7D", // Secondary green
          600: "#009966",
          700: "#025B40", // Dark green
          800: "#024732",
          900: "#013324",
          950: "#011F16",
        },
        rie: {
          bg: "#09090B",
          sidebar: "#121215",
          surface: "#141417",
          "surface-hover": "#18181B",
          border: "#27272A",
          "border-strong": "#3F3F47",
          accent: {
            DEFAULT: "#00D492",
            hover: "#00BC7D",
            dark: "#025B40",
          },
          text: {
            primary: "#F4F4F5",
            secondary: "#A1A1AA",
            muted: "#71717A",
          },
        },
      },
    },
  },
  plugins: [],
};


