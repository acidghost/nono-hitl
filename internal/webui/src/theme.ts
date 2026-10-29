// Built twice: as a classic script in <head>, so the theme applies before first paint, and
// into app.js for the Help picker. The mode lives on <html>, so both copies share it.
export type ThemeMode = "system" | "light" | "dark";

const preferenceKey = "nono-hitl-mint-theme";
const system = window.matchMedia("(prefers-color-scheme: dark)");

export function validMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

export function themeMode(): ThemeMode {
  const mode = document.documentElement.dataset.themeMode;
  return validMode(mode) ? mode : "system";
}

function apply(mode: ThemeMode) {
  const effective = mode === "system" ? (system.matches ? "dark" : "light") : mode;
  document.documentElement.dataset.theme = effective;
  document.documentElement.dataset.themeMode = mode;
}

export function setThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem(preferenceKey, mode);
  } catch {}
  apply(mode);
}

// The head copy runs first; the copy inside app.js finds the mode already set.
if (!document.documentElement.dataset.themeMode) {
  let mode: ThemeMode = "system";
  try {
    const saved = localStorage.getItem(preferenceKey);
    if (validMode(saved)) mode = saved;
  } catch {} // file:// and private contexts may disallow storage.
  const forced = new URLSearchParams(window.location.search).get("theme");
  if (forced === "light" || forced === "dark") mode = forced;
  apply(mode);
  system.addEventListener("change", () => {
    if (themeMode() === "system") apply("system");
  });
}
