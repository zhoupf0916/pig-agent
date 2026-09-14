const path = require("node:path");
const typography = require("@tailwindcss/typography");

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    path.join(__dirname, "index.html"),
    path.join(__dirname, "src/**/*.{ts,tsx}"),
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#F7F7F4",
          100: "#F1F1ED",
          200: "#E6E6E0",
          300: "#D4D4CC",
          400: "#A8A8A0",
          500: "#6E6E67",
          600: "#4C4C47",
          700: "#2E2E2A",
          800: "#1C1C19",
          900: "#141411",
          950: "#0C0C0B",
        },
        accent: {
          DEFAULT: "#2F6F6C",
          mute: "#3A6F6C",
          soft: "#E7F0EF",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          '"PingFang SC"',
          '"Source Han Sans SC"',
          '"Noto Sans SC"',
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          '"IBM Plex Mono"',
          "Menlo",
          "monospace",
        ],
      },
      boxShadow: {
        panel: "0 1px 2px rgba(20,20,17,0.04), 0 8px 24px rgba(20,20,17,0.06)",
        lift: "0 1px 2px rgba(20,20,17,0.05), 0 16px 40px rgba(20,20,17,0.08)",
      },
    },
  },
  plugins: [typography],
};
