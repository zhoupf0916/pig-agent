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
          50: "#F7F7F8",
          100: "#F3F4F6",
          200: "#EEF0F3",
          300: "#E5E7EB",
          400: "#D1D5DB",
          500: "#9CA3AF",
          600: "#6B7280",
          700: "#374151",
          800: "#111827",
          900: "#111827",
          950: "#111827",
        },
        accent: {
          DEFAULT: "#10A37F",
          mute: "#0E8C6C",
          soft: "#E6F6F1",
        },
        danger: {
          DEFAULT: "#DC2626",
          soft: "#FEE2E2",
        },
        warning: {
          DEFAULT: "#D97706",
          soft: "#FEF3C7",
        },
        success: {
          DEFAULT: "#059669",
          soft: "#D1FAE5",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          '"PingFang SC"',
          '"Noto Sans SC"',
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      fontSize: {
        body: ["15px", { lineHeight: "1.6" }],
        meta: ["12px", { lineHeight: "1.5" }],
      },
      borderRadius: {
        card: "10px",
        btn: "8px",
      },
      boxShadow: {
        panel: "0 1px 2px rgba(17,24,39,0.04), 0 8px 24px rgba(17,24,39,0.05)",
        lift: "0 1px 2px rgba(17,24,39,0.05), 0 16px 40px rgba(17,24,39,0.08)",
      },
    },
  },
  plugins: [typography],
};
