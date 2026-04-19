import { Menu } from "@base-ui/react/menu";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import type { ModelListItem } from "~/lib/types";
import { cn } from "~/lib/utils";

const rootApi = getRouteApi("__root__");

const LOCAL_STORAGE_KEY = "flitterbot:selected-model-id";
const MODELS_QUERY_KEY = ["models"] as const;

export type ModelSelectorProps = {
  /** Currently selected model id. Parent owns state; selector just renders it. */
  value: string | null;
  /** Called when the user picks a different model. */
  onChange: (modelId: string) => void;
  /** Compact mode hides the label text, showing only the chevron + provider glyph. */
  compact?: boolean;
  disabled?: boolean;
};

/**
 * Small dropdown trigger that sits next to the composer's send button.
 * Reads the configured models from `GET /api/models` and lets the user pick
 * which model the next message targets. Selection is owned by the parent —
 * this component is purely presentational plus a menu.
 */
export const ModelSelector = memo(function ModelSelector({
  value,
  onChange,
  compact,
  disabled,
}: ModelSelectorProps) {
  const { apiClient } = rootApi.useRouteContext();
  const { data } = useQuery({
    queryKey: MODELS_QUERY_KEY,
    queryFn: () => apiClient.listModels(),
    staleTime: 5 * 60 * 1000,
  });

  const models = data?.models ?? [];
  const currentModel = useMemo(
    () => models.find((m) => m.id === value) ?? models.find((m) => m.id === data?.defaultModel),
    [models, value, data?.defaultModel],
  );

  if (models.length === 0) {
    return null;
  }

  const triggerLabel = currentModel?.label ?? "Select model";

  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={disabled}
        className={cn(
          "inline-flex items-center gap-1 h-7 rounded-md border border-border/60 bg-background/40 text-xs text-muted-foreground",
          "hover:text-foreground hover:bg-accent/50 hover:border-border transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          compact ? "px-1.5" : "px-2",
        )}
        title={
          currentModel
            ? `${currentModel.label} (${currentModel.provider}/${currentModel.modelId})`
            : "Pick a model"
        }
      >
        <span className={cn("truncate max-w-[180px]", compact && "sr-only")}>{triggerLabel}</span>
        <ChevronDownIcon className="h-3 w-3 shrink-0" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end">
          <Menu.Popup
            className={cn(
              "z-50 min-w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none",
              "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-opacity duration-100",
            )}
          >
            {models.map((model) => (
              <ModelMenuItem
                key={model.id}
                model={model}
                selected={model.id === currentModel?.id}
                onSelect={() => onChange(model.id)}
              />
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
});

function ModelMenuItem({
  model,
  selected,
  onSelect,
}: {
  model: ModelListItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Menu.Item
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm outline-none",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
      )}
    >
      <CheckIcon
        className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")}
      />
      <div className="flex flex-col">
        <span className="font-medium leading-tight">{model.label}</span>
        <span className="text-[11px] text-muted-foreground/70 leading-tight">
          {model.provider} · {model.modelId}
          {model.thinkingLevel ? ` · thinking=${model.thinkingLevel}` : ""}
        </span>
      </div>
    </Menu.Item>
  );
}

/**
 * Hook: owns the selected-model state for a composer. Rehydrates from
 * localStorage on mount, falls back to the server's `defaultModel`, and
 * persists user changes across reloads.
 *
 * Returns a tuple of `[selectedModelId | null, setSelected, models]` so the
 * composer can both show the selector and forward the id on submit.
 */
export function useSelectedModel(): [
  selectedModelId: string | null,
  setSelected: (modelId: string) => void,
  available: ModelListItem[],
  defaultModelId: string | null,
] {
  const { apiClient } = rootApi.useRouteContext();
  const { data } = useQuery({
    queryKey: MODELS_QUERY_KEY,
    queryFn: () => apiClient.listModels(),
    staleTime: 5 * 60 * 1000,
  });
  const models = data?.models ?? [];
  const defaultModelId = data?.defaultModel ?? null;

  // Read localStorage lazily on first render — gated on `typeof window` for SSR.
  const [selected, setSelectedState] = useLocalStorageModel();

  // When the server lists a default and we have no stored selection, surface
  // the default as the effective value without writing to localStorage — the
  // user hasn't explicitly chosen anything yet, so we shouldn't persist it.
  const effective = selected ?? defaultModelId;

  // Prune invalid stored selections (e.g. model removed from config). Only
  // clears when models have loaded AND the stored id is missing from the list.
  useEffect(() => {
    if (!selected || models.length === 0) return;
    if (!models.some((m) => m.id === selected)) {
      setSelectedState(null);
    }
  }, [selected, models, setSelectedState]);

  const setSelected = (modelId: string) => setSelectedState(modelId);

  return [effective, setSelected, models, defaultModelId];
}

/**
 * Lightweight localStorage-backed state. Intentionally not cross-tab reactive —
 * no `storage` event listener — because a model change in another tab shouldn't
 * silently hijack the active composer's selection.
 */
function useLocalStorageModel(): [string | null, (v: string | null) => void] {
  const [value, setValue] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(LOCAL_STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const set = (next: string | null) => {
    setValue(next);
    if (typeof window !== "undefined") {
      try {
        if (next) window.localStorage.setItem(LOCAL_STORAGE_KEY, next);
        else window.localStorage.removeItem(LOCAL_STORAGE_KEY);
      } catch {
        /* ignore quota/denied */
      }
    }
  };

  return [value, set];
}
