import { useSyncExternalStore } from "react";

function getModifier(): string {
  if (typeof navigator === "undefined") return "Alt";
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? "Opt" : "Alt";
}

const emptySubscribe = () => () => {};

/** Returns 'Opt' on Mac, 'Alt' on other platforms. SSR-safe — returns "" on the server. */
export function useModifierLabel(): string {
  return useSyncExternalStore(emptySubscribe, getModifier, () => "");
}
