import { useSyncExternalStore } from "react";

function getModifier(): string {
  if (typeof navigator === "undefined") return "Alt";
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? "Opt" : "Alt";
}

const emptySubscribe = () => () => {};

export function useModifierLabel(): string {
  return useSyncExternalStore(emptySubscribe, getModifier, () => "");
}
