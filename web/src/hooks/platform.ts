import { useSyncExternalStore } from "react";

const modifierLabel =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
    ? "Opt"
    : "Alt";
const emptySubscribe = () => () => {};
const getModifierLabel = () => modifierLabel;

export function useModifierLabel(): string {
  return useSyncExternalStore(emptySubscribe, getModifierLabel, () => "Opt");
}
