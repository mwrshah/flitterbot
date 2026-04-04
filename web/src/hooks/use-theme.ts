import { useCallback, useEffect } from "react";
import { useUserConfig } from "~/hooks/use-user-config";

type Theme = "light" | "dark" | "system";

const CONFIG_KEY = "theme";

function getResolvedTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  const resolved = getResolvedTheme(theme);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.style.colorScheme = resolved;
}

export function useTheme() {
  const { config, setConfig } = useUserConfig();
  const theme = (config[CONFIG_KEY] as Theme) || "system";

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Re-apply when system preference changes while in "system" mode
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (theme === "system") applyTheme("system");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = useCallback(
    (next: Theme) => {
      applyTheme(next);
      setConfig(CONFIG_KEY, next);
    },
    [setConfig],
  );

  return { theme, setTheme, resolvedTheme: getResolvedTheme(theme) };
}
