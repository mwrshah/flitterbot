import { Menu } from "@base-ui/react/menu";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
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
  /** Compact mode hides the label text in the trigger, showing only the chevron. */
  compact?: boolean;
  disabled?: boolean;
};

/**
 * Dropdown that sits next to the composer's send button. Shows two sections:
 *
 *   1. *Pinned* — the curated shortlist from `config.models[]`.
 *   2. *All models* — the full pi SDK catalog, grouped by provider, with a
 *      type-to-filter search. Entries whose provider has no auth configured
 *      are rendered dimmed with a small badge.
 *
 * The user's selection is the composite `provider/modelId` for catalog entries
 * (or a curated id) and is persisted to localStorage by `useSelectedModel()`.
 * localStorage always overrides the server's `defaultModel`.
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

  const pinned = data?.pinned ?? [];
  const all = data?.all ?? [];
  const defaultModelId = data?.defaultModel ?? null;

  // The effective selected id — localStorage overrides server default.
  const effectiveId = value ?? defaultModelId;
  const currentModel = useMemo(() => {
    if (!effectiveId) return undefined;
    return (
      pinned.find((m) => m.id === effectiveId) ?? all.find((m) => m.id === effectiveId) ?? undefined
    );
  }, [effectiveId, pinned, all]);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  // Reset search each time the menu opens so stale filters don't leak.
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const filteredAll = useMemo(() => filterModels(all, search), [all, search]);
  const filteredPinned = useMemo(() => filterModels(pinned, search), [pinned, search]);
  const groupedAll = useMemo(() => groupByProvider(filteredAll), [filteredAll]);

  if (pinned.length === 0 && all.length === 0) {
    return null;
  }

  const triggerLabel = currentModel?.label ?? "Select model";

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
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
              "z-50 w-[360px] max-h-[70vh] flex flex-col rounded-lg border border-border bg-popover text-popover-foreground shadow-md outline-none",
              "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-opacity duration-100",
            )}
          >
            <SearchBox value={search} onChange={setSearch} />
            <div className="flex-1 overflow-y-auto p-1">
              {filteredPinned.length > 0 && (
                <ModelSection label="Pinned">
                  {filteredPinned.map((model) => (
                    <ModelMenuItem
                      key={`pinned:${model.id}`}
                      model={model}
                      selected={model.id === effectiveId}
                      onSelect={() => {
                        onChange(model.id);
                        setOpen(false);
                      }}
                    />
                  ))}
                </ModelSection>
              )}

              {groupedAll.length > 0 &&
                groupedAll.map(([provider, models]) => (
                  <ModelSection key={provider} label={provider}>
                    {models.map((model) => (
                      <ModelMenuItem
                        key={`all:${model.id}`}
                        model={model}
                        selected={model.id === effectiveId}
                        onSelect={() => {
                          onChange(model.id);
                          setOpen(false);
                        }}
                      />
                    ))}
                  </ModelSection>
                ))}

              {filteredPinned.length === 0 && groupedAll.length === 0 && (
                <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                  No models match "{search}"
                </div>
              )}
            </div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
});

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Autofocus the search input when the menu opens so the user can start
  // typing immediately. Base UI steals focus onto the first MenuItem by
  // default; we override it after the initial mount.
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
      <SearchIcon className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
      <input
        ref={inputRef}
        type="text"
        placeholder="Search models…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // Base UI's Menu treats arrow keys as item navigation; swallow them
        // here so typing in the filter doesn't jump focus to the list.
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
            e.stopPropagation();
          }
        }}
        className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 outline-none"
      />
    </div>
  );
}

function ModelSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1">
      <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
        {label}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function ModelMenuItem({
  model,
  selected,
  onSelect,
}: {
  model: ModelListItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const available = model.available !== false;
  return (
    <Menu.Item
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm outline-none",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        !available && "opacity-60",
      )}
    >
      <CheckIcon
        className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")}
      />
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium leading-tight">{model.label}</span>
        <span className="text-[11px] text-muted-foreground/70 leading-tight truncate">
          {model.provider} · {model.modelId}
          {model.contextWindow ? ` · ${formatContext(model.contextWindow)}` : ""}
          {model.thinkingLevel ? ` · thinking=${model.thinkingLevel}` : ""}
        </span>
      </div>
      {!available && (
        <span
          className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
          title={`No auth configured for provider "${model.provider}"`}
        >
          no auth
        </span>
      )}
    </Menu.Item>
  );
}

/** Filter across `label`, `modelId`, and `provider` — whitespace-separated
 *  tokens all have to match (AND semantics) so `opus anthropic` narrows
 *  properly. Case-insensitive. */
function filterModels(models: ModelListItem[], query: string): ModelListItem[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return models;
  const tokens = trimmed.split(/\s+/);
  return models.filter((m) => {
    const haystack = `${m.label} ${m.modelId} ${m.provider} ${m.name ?? ""}`.toLowerCase();
    return tokens.every((t) => haystack.includes(t));
  });
}

function groupByProvider(models: ModelListItem[]): Array<[string, ModelListItem[]]> {
  const groups = new Map<string, ModelListItem[]>();
  for (const m of models) {
    const bucket = groups.get(m.provider);
    if (bucket) bucket.push(m);
    else groups.set(m.provider, [m]);
  }
  return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k ctx`;
  return `${tokens} ctx`;
}

/**
 * Hook: owns the selected-model state for a composer. Rehydrates from
 * localStorage on mount, falls back to the server's `defaultModel`, and
 * persists user changes across reloads. Selections are validated against
 * the combined pinned+all catalog; stale ids (e.g. model removed from
 * pi-mono) are pruned silently.
 */
export function useSelectedModel(): [
  selectedModelId: string | null,
  setSelected: (modelId: string) => void,
] {
  const { apiClient } = rootApi.useRouteContext();
  const { data } = useQuery({
    queryKey: MODELS_QUERY_KEY,
    queryFn: () => apiClient.listModels(),
    staleTime: 5 * 60 * 1000,
  });
  const defaultModelId = data?.defaultModel ?? null;

  const [selected, setSelectedState] = useLocalStorageModel();

  const effective = selected ?? defaultModelId;

  // Prune invalid stored selections once the catalog loads.
  useEffect(() => {
    if (!selected || !data) return;
    const exists =
      data.pinned.some((m) => m.id === selected) || data.all.some((m) => m.id === selected);
    if (!exists) setSelectedState(null);
  }, [selected, data, setSelectedState]);

  const setSelected = (modelId: string) => setSelectedState(modelId);
  return [effective, setSelected];
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
