import { Moon, Sun } from "lucide-react";
import type { Theme } from "../lib/theme";
import { toggleTheme } from "../lib/theme";

export function ThemeToggle({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (theme: Theme) => void;
}) {
  const next = toggleTheme(theme);
  const label = next === "dark" ? "切换到深色" : "切换到浅色";
  return (
    <button
      type="button"
      className="btn-ghost"
      aria-label={label}
      title={label}
      onClick={() => onChange(next)}
    >
      {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
      {theme === "dark" ? "浅色" : "深色"}
    </button>
  );
}
