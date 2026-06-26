// ponytail: collapse this debug toggle layer to direct DEV-only console calls or remove it.
const STREAMING_UI_DEBUG_STORAGE_KEY = "flitterbot:debug:streaming-ui";
const STREAMING_UI_DEBUG_GLOBAL_KEY = "__FLITTERBOT_DEBUG_STREAMING_UI";

type DebugGlobal = typeof globalThis & Record<typeof STREAMING_UI_DEBUG_GLOBAL_KEY, unknown>;

function browserToggleEnabled(): boolean {
  if (typeof window === "undefined") return false;

  const globalValue = (globalThis as DebugGlobal)[STREAMING_UI_DEBUG_GLOBAL_KEY];
  if (globalValue === true) return true;

  try {
    return window.localStorage.getItem(STREAMING_UI_DEBUG_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function isStreamingUiDebugEnabled(): boolean {
  return (
    import.meta.env.DEV &&
    (import.meta.env.VITE_DEBUG_STREAMING_UI === "true" || browserToggleEnabled())
  );
}

export function streamingUiDebug(message?: unknown, ...optionalParams: unknown[]): void {
  if (!isStreamingUiDebugEnabled()) return;
  console.debug(message, ...optionalParams);
}

export function streamingUiDebugWarn(message?: unknown, ...optionalParams: unknown[]): void {
  if (!isStreamingUiDebugEnabled()) return;
  console.warn(message, ...optionalParams);
}
