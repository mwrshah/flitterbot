import { useSyncExternalStore } from "react";
import type { ControlSurfaceSettings } from "./api";

const STORAGE_KEY = "autonoma.web.control-surface";

function loadSettings(): ControlSurfaceSettings {
  if (typeof window === "undefined") {
    return {
      baseUrl: "http://127.0.0.1:18820",
      token: "",
      useStubFallback: true,
    };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ControlSurfaceSettings>;
      return {
        baseUrl:
          parsed.baseUrl || import.meta.env.VITE_AUTONOMA_BASE_URL || "http://127.0.0.1:18820",
        token: parsed.token || import.meta.env.VITE_AUTONOMA_TOKEN || "",
        useStubFallback: parsed.useStubFallback ?? true,
      };
    }
  } catch {
    // Ignore corrupted storage.
  }

  return {
    baseUrl: import.meta.env.VITE_AUTONOMA_BASE_URL || "http://127.0.0.1:18820",
    token: import.meta.env.VITE_AUTONOMA_TOKEN || "",
    useStubFallback: true,
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;

export function createSettingsStore(onSettingsChange?: (settings: ControlSurfaceSettings) => void) {
  let settings = loadSettings();
  const listeners = new Set<() => void>();

  function get(): ControlSurfaceSettings {
    return settings;
  }

  function set(next: Partial<ControlSurfaceSettings>) {
    settings = { ...settings, ...next };
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    }
    onSettingsChange?.(settings);
    for (const fn of listeners) fn();
  }

  function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }

  return { get, set, subscribe };
}

export function useSettings(store: SettingsStore): ControlSurfaceSettings {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
