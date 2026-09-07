export type ThemePreference = "system" | "dark" | "light";
export function parseTheme(value: string | null): ThemePreference {
  return value === "dark" || value === "light" ? value : "system";
}
export function resolveTheme(preference: ThemePreference, systemDark: boolean) {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}
