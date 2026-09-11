import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import {
  SHORTCUT_CATALOG,
  SHORTCUT_OPTIONS,
  type ShortcutActionId,
  type ShortcutOwner,
} from "../../../src/shortcuts/catalog.ts";
import {
  createShortcutRegistry,
  type ShortcutHandler,
  type ShortcutHandlers,
  type ShortcutLabelOptions,
  type ShortcutRegistry,
} from "../../../src/shortcuts/registry.ts";
import { isShortcutInput } from "./shortcut-dom";
import { handleTextInputKeyDown } from "./text-input";
import type { ShortcutBindingsConfig } from "./types";

export type { ShortcutKeyboardEvent } from "../../../src/shortcuts/registry.ts";
export type ShortcutActionHandlers = Partial<Record<ShortcutActionId, ShortcutHandler>>;

const ShortcutRegistryContext = createContext<ShortcutRegistry | null>(null);
const ACTION_SEPARATOR = "\u0000";

function reportShortcutError(error: unknown) {
  toast.error(error instanceof Error ? error.message : String(error), { id: "shortcut-error" });
}

export function ShortcutsProvider({
  overrides,
  children,
}: {
  overrides?: ShortcutBindingsConfig;
  children: ReactNode;
}) {
  const [registry] = useState(() =>
    createShortcutRegistry({
      catalog: SHORTCUT_CATALOG,
      ...SHORTCUT_OPTIONS,
      overrides,
      onError: reportShortcutError,
    }),
  );

  useLayoutEffect(() => {
    try {
      registry.setOverrides(overrides);
    } catch (error) {
      reportShortcutError(error);
    }
  }, [registry, overrides]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (handleTextInputKeyDown(event)) {
        registry.reset();
        return;
      }
      registry.handleKeyDown(event, isShortcutInput(document.activeElement));
    };
    const resetPending = () => registry.reset();
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", resetPending);
    document.addEventListener("focusin", resetPending);
    document.addEventListener("focusout", resetPending);
    document.addEventListener("compositionstart", resetPending);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", resetPending);
      document.removeEventListener("focusin", resetPending);
      document.removeEventListener("focusout", resetPending);
      document.removeEventListener("compositionstart", resetPending);
      registry.reset();
    };
  }, [registry]);

  return <ShortcutRegistryContext value={registry}>{children}</ShortcutRegistryContext>;
}

function useShortcutRegistry(): ShortcutRegistry {
  const registry = useContext(ShortcutRegistryContext);
  if (!registry) throw new Error("useShortcuts requires a <ShortcutsProvider>");
  return registry;
}

export function useShortcuts(owner: ShortcutOwner, handlers: ShortcutActionHandlers): void {
  const registry = useShortcutRegistry();
  const handlersRef = useRef(handlers);
  useLayoutEffect(() => {
    handlersRef.current = handlers;
  });
  const actionKey = Object.keys(handlers).sort().join(ACTION_SEPARATOR);

  useLayoutEffect(() => {
    if (!actionKey) return;
    const proxies: ShortcutHandlers = {};
    for (const actionId of actionKey.split(ACTION_SEPARATOR) as ShortcutActionId[]) {
      proxies[actionId] = {
        enabled: (event) => {
          const handler = handlersRef.current[actionId];
          if (!handler) return false;
          return typeof handler.enabled === "function"
            ? handler.enabled(event)
            : handler.enabled !== false;
        },
        run: (event) => handlersRef.current[actionId]?.run(event),
      };
    }
    return registry.register(owner, proxies);
  }, [registry, owner, actionKey]);
}

export function useShortcutBindingLabel(
  actionId: ShortcutActionId | undefined,
  options: ShortcutLabelOptions = {},
): string {
  const registry = useShortcutRegistry();
  const { compact, altLabel } = options;
  const getLabel = useCallback(
    () => (actionId ? registry.getLabel(actionId, { compact, altLabel }) : ""),
    [registry, actionId, compact, altLabel],
  );
  return useSyncExternalStore(registry.subscribe, getLabel, getLabel);
}

export function useShortcutBindingLabels(
  actionIds: readonly ShortcutActionId[],
  options: ShortcutLabelOptions = {},
): readonly string[] {
  const registry = useShortcutRegistry();
  const { compact, altLabel } = options;
  const actionKey = actionIds.join(ACTION_SEPARATOR);
  const getLabels = useMemo(() => {
    const ids = actionKey ? actionKey.split(ACTION_SEPARATOR) : [];
    let snapshot: string[] = [];
    return () => {
      const next = ids.map((id) => registry.getLabel(id, { compact, altLabel }));
      if (
        next.length !== snapshot.length ||
        next.some((label, index) => label !== snapshot[index])
      ) {
        snapshot = next;
      }
      return snapshot;
    };
  }, [registry, actionKey, compact, altLabel]);
  return useSyncExternalStore(registry.subscribe, getLabels, getLabels);
}
