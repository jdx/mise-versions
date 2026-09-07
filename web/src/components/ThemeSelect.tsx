import { useEffect, useState } from "preact/hooks";
import { parseTheme, resolveTheme, type ThemePreference } from "../lib/theme";

export function ThemeSelect() {
  const [preference, setPreference] = useState<ThemePreference>("system");
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      let value: ThemePreference = "system";
      try {
        value = parseTheme(localStorage.getItem("mise-theme"));
      } catch {}
      setPreference(value);
      document.documentElement.dataset.theme = resolveTheme(
        value,
        media.matches,
      );
    };
    sync();
    media.addEventListener("change", sync);
    window.addEventListener("storage", sync);
    return () => {
      media.removeEventListener("change", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return (
    <label class="theme-select">
      <span class="sr-only">Color theme</span>
      <select
        value={preference}
        onChange={(e) => {
          const value = parseTheme(e.currentTarget.value);
          setPreference(value);
          try {
            localStorage.setItem("mise-theme", value);
          } catch {}
          document.documentElement.dataset.theme = resolveTheme(
            value,
            matchMedia("(prefers-color-scheme: dark)").matches,
          );
        }}
      >
        <option value="system">◐ System</option>
        <option value="dark">◑ Dark</option>
        <option value="light">☀ Light</option>
      </select>
    </label>
  );
}
