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
          50: "var(--bg-app)",
          100: "var(--bg-subtle)",
          200: "var(--bg-hover)",
          300: "var(--border-default)",
          400: "var(--border-strong)",
          500: "var(--text-muted)",
          600: "var(--text-secondary)",
          700: "var(--text-secondary-strong)",
          800: "var(--text-primary)",
          900: "var(--text-primary)",
          950: "var(--text-primary)",
        },
        panel: "var(--bg-panel)",
        overlay: "var(--overlay)",
        accent: {
          DEFAULT: "var(--accent)",
          mute: "var(--accent-mute)",
          soft: "var(--accent-soft)",
        },
        danger: {
          DEFAULT: "var(--danger)",
          soft: "var(--danger-soft)",
        },
        warning: {
          DEFAULT: "var(--warning)",
          soft: "var(--warning-soft)",
        },
        success: {
          DEFAULT: "var(--success)",
          soft: "var(--success-soft)",
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
        panel: "0 1px 2px rgba(17,24,39,0.06), 0 8px 24px rgba(17,24,39,0.06)",
        lift: "0 1px 2px rgba(17,24,39,0.06), 0 16px 40px rgba(17,24,39,0.10)",
      },
    },
  },
  plugins: [typography],
};
