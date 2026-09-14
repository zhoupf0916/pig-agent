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
          950: "#0b0d11",
          900: "#11141a",
          850: "#161a22",
          800: "#1c212b",
          700: "#2a3140",
          500: "#8b93a7",
          300: "#c6cbd6",
        },
        accent: {
          DEFAULT: "#5aa7ff",
          dim: "#3d7fc4",
        },
      },
      fontFamily: {
        sans: [
          '"Source Han Sans SC"',
          '"Noto Sans SC"',
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        mono: ['"IBM Plex Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      boxShadow: {
        panel: "0 0 0 1px rgba(255,255,255,0.04), 0 12px 40px rgba(0,0,0,0.35)",
      },
    },
  },
  plugins: [typography],
};
