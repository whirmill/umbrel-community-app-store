import { useEffect, useState } from "react";
export type Theme = "light" | "dark" | "system";
export function validTheme(v: unknown): Theme {
  return v === "light" || v === "dark" ? v : "system";
}
export function ThemePicker() {
  const [mode, setMode] = useState<Theme>(() => {
    try {
      return validTheme(localStorage.getItem("satssurge.theme"));
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = mode === "dark" || (mode === "system" && query.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", dark ? "#141b18" : "#f5f5f0");
    };
    apply();
    const sync = (e: StorageEvent) => {
      if (e.key === "satssurge.theme") setMode(validTheme(e.newValue));
    };
    query.addEventListener("change", apply);
    addEventListener("storage", sync);
    return () => {
      query.removeEventListener("change", apply);
      removeEventListener("storage", sync);
    };
  }, [mode]);
  return (
    <label className="theme-picker">
      Tema{" "}
      <select
        aria-label="Tema"
        value={mode}
        onChange={(e) => {
          const next = validTheme(e.target.value);
          setMode(next);
          try {
            localStorage.setItem("satssurge.theme", next);
          } catch {}
        }}
      >
        <option value="system">Sistema</option>
        <option value="light">Chiaro</option>
        <option value="dark">Scuro</option>
      </select>
    </label>
  );
}
