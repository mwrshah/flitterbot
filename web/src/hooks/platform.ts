/** Returns 'Opt' on Mac, 'Alt' on other platforms. */
export function getModifierLabel(): string {
  if (typeof navigator === "undefined") return "Alt";
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? "Opt" : "Alt";
}
