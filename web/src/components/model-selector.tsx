import { Menu } from "@base-ui/react/menu";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, SearchIcon, StarIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ModelListItem, ModelsListResponse } from "~/lib/types";
import { cn } from "~/lib/utils";

const rootApi = getRouteApi("__root__");

const MODELS_QUERY_KEY = ["models", "auth-kind-v2"] as const;

export type ModelSelectorProps = {
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
 * Selecting a model sets it as the server-side default; `defaultModel` from
 * the models query is the single source of truth.
 */
export const ModelSelector = memo(function ModelSelector({
  compact,
  disabled,
}: ModelSelectorProps) {
  const { apiClient } = rootApi.useRouteContext();
  const { data } = useQuery({
    queryKey: MODELS_QUERY_KEY,
    queryFn: () => apiClient.listModels(),
    // Auth can change outside the web app (`pi /login`, env updates, token refresh).
    // Keep the selector's badges/order tied to the control surface's current auth state.
    staleTime: 0,
  });

  const pinned = data?.pinned ?? [];
  const all = data?.all ?? [];
  const defaultModelId = data?.defaultModel ?? null;
  // Include both the curated id AND the composite `provider/modelId` so an
  // "All" entry shows its star whether it was pinned under its curated alias
  // or its composite form.
  const pinnedIds = useMemo(() => {
    const set = new Set<string>();
    for (const m of pinned) {
      set.add(m.id);
      set.add(`${m.provider}/${m.modelId}`);
    }
    return set;
  }, [pinned]);

  const queryClient = useQueryClient();
  const pinMutation = useMutation({
    mutationFn: ({ id, pin, label }: { id: string; pin: boolean; label?: string }) =>
      apiClient.pinModel(id, pin, label),
    onSuccess: (result, vars) => {
      // Optimistic-write: drop the fresh payload straight into the cache so
      // the popup rerenders with the new pinned state without a round-trip GET.
      queryClient.setQueryData<ModelsListResponse>(MODELS_QUERY_KEY, (old) =>
        old ? { ...old, pinned: result.pinned, defaultModel: result.defaultModel } : old,
      );
      toast.success(vars.pin ? "Pinned to config" : "Unpinned");
    },
    onError: (error) => {
      toast.error(`Pin failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  const defaultMutation = useMutation({
    mutationFn: (id: string) => apiClient.setDefaultModel(id),
    onSuccess: (result) => {
      queryClient.setQueryData<ModelsListResponse>(MODELS_QUERY_KEY, (old) =>
        old ? { ...old, pinned: result.pinned, defaultModel: result.defaultModel } : old,
      );
      toast.success("Default model updated in config");
    },
    onError: (error) => {
      toast.error(`Set default failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  });

  const currentModel = useMemo(() => {
    if (!defaultModelId) return undefined;
    return (
      pinned.find((m) => matchesModelId(m, defaultModelId)) ??
      all.find((m) => matchesModelId(m, defaultModelId)) ??
      undefined
    );
  }, [defaultModelId, pinned, all]);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  // Reset search each time the menu opens so stale filters don't leak.
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const filteredAll = useMemo(() => filterModels(all, search), [all, search]);
  const filteredPinned = useMemo(() => filterModels(pinned, search), [pinned, search]);
  const groupedAll = useMemo(() => groupByAuthKind(filteredAll), [filteredAll]);

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
                      selected={defaultModelId ? matchesModelId(model, defaultModelId) : false}
                      isPinned
                      canUnpin={pinned.length > 1}
                      onSelect={() => {
                        defaultMutation.mutate(model.id);
                        setOpen(false);
                      }}
                      onTogglePin={() => pinMutation.mutate({ id: model.id, pin: false })}
                      busy={pinMutation.isPending || defaultMutation.isPending}
                    />
                  ))}
                </ModelSection>
              )}

              {groupedAll.length > 0 &&
                groupedAll.map(([section, models]) => (
                  <ModelSection key={section} label={section}>
                    {models.map((model) => {
                      const isPinned = pinnedIds.has(model.id);
                      return (
                        <ModelMenuItem
                          key={`all:${model.id}`}
                          model={model}
                          selected={defaultModelId ? matchesModelId(model, defaultModelId) : false}
                          isPinned={isPinned}
                          canUnpin={pinned.length > 1}
                          onSelect={() => {
                            defaultMutation.mutate(model.id);
                            setOpen(false);
                          }}
                          onTogglePin={() =>
                            pinMutation.mutate({
                              id: model.id,
                              pin: !isPinned,
                              ...(isPinned ? {} : { label: model.name ?? model.label }),
                            })
                          }
                          busy={pinMutation.isPending || defaultMutation.isPending}
                        />
                      );
                    })}
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
        // Base UI's Menu wires floating-ui's useTypeahead + useListNavigation
        // to the popup's keydown. Any character that bubbles out of this
        // input triggers typeahead, which sets activeIndex and steals DOM
        // focus onto the matching MenuItem — after which no further keys
        // reach the input. Stop all keys here except Escape (so the menu
        // still dismisses) and Tab (so focus can leave the popup normally).
        onKeyDown={(e) => {
          if (e.key !== "Escape" && e.key !== "Tab") {
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
  isPinned,
  canUnpin,
  onSelect,
  onTogglePin,
  busy,
}: {
  model: ModelListItem;
  selected: boolean;
  isPinned: boolean;
  canUnpin: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
  busy: boolean;
}) {
  const available = model.available !== false;
  // When pinned, the star turns into an unpin action; when not pinned, it's a
  // pin action. Disabled for the last pinned entry (server enforces the same).
  const pinDisabled = busy || (isPinned && !canUnpin);
  const pinTitle = isPinned
    ? canUnpin
      ? "Unpin from config"
      : "Keep at least one pinned model"
    : "Pin to config";

  return (
    <div
      className={cn(
        "group/row flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-sm",
        "hover:bg-accent/50",
        !available && "opacity-60",
      )}
    >
      <Menu.Item
        onClick={onSelect}
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer items-start gap-2 outline-none",
          "data-[highlighted]:text-accent-foreground",
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
      </Menu.Item>
      <AuthBadge model={model} />
      <button
        type="button"
        disabled={pinDisabled}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin();
        }}
        className={cn(
          "shrink-0 self-center rounded p-1 transition-colors",
          "text-muted-foreground/50 hover:text-foreground hover:bg-accent",
          "disabled:cursor-not-allowed disabled:opacity-40",
          isPinned && "text-amber-500/80 hover:text-amber-500",
        )}
        title={pinTitle}
      >
        <StarIcon className={cn("h-3.5 w-3.5", isPinned && "fill-current")} />
      </button>
    </div>
  );
}

/** True when `stored` matches this catalog entry by either curated id or the
 *  composite `provider/modelId` form. Curated ids (e.g. `claude-opus-4-7`)
 *  and composite ids (e.g. `anthropic/claude-opus-4-7`) refer to the same
 *  underlying model; treating them as equivalent avoids mismatches when the
 *  user pins/unpins entries. */
function matchesModelId(
  m: Pick<ModelListItem, "id" | "provider" | "modelId">,
  stored: string,
): boolean {
  return m.id === stored || `${m.provider}/${m.modelId}` === stored;
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

function AuthBadge({ model }: { model: ModelListItem }) {
  if (model.authKind === "subscription") {
    return (
      <span
        className="shrink-0 self-center rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400"
        title={`Using subscription/OAuth token auth for provider "${model.provider}"`}
      >
        subscription
      </span>
    );
  }
  if (model.authKind === "api_key") {
    return (
      <span
        className="shrink-0 self-center rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-600 dark:text-sky-400"
        title={`Using API key auth for provider "${model.provider}"`}
      >
        api key
      </span>
    );
  }
  return (
    <span
      className="shrink-0 self-center rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
      title={`No auth configured for provider "${model.provider}"`}
    >
      no auth
    </span>
  );
}

function groupByAuthKind(models: ModelListItem[]): Array<[string, ModelListItem[]]> {
  const groups = new Map<string, ModelListItem[]>();
  for (const m of models) {
    const label = authSectionLabel(m.authKind);
    const bucket = groups.get(label);
    if (bucket) bucket.push(m);
    else groups.set(label, [m]);
  }
  return AUTH_SECTION_ORDER.flatMap((label) => {
    const modelsForSection = groups.get(label);
    if (!modelsForSection?.length) return [];
    return [[label, modelsForSection.sort(compareModelsForDisplay)] as [string, ModelListItem[]]];
  });
}

const AUTH_SECTION_ORDER = ["Subscription/token auth", "API key auth", "No auth"] as const;

function authSectionLabel(
  authKind: ModelListItem["authKind"],
): (typeof AUTH_SECTION_ORDER)[number] {
  if (authKind === "subscription") return "Subscription/token auth";
  if (authKind === "api_key") return "API key auth";
  return "No auth";
}

function compareModelsForDisplay(a: ModelListItem, b: ModelListItem): number {
  const version = compareModelVersionDesc(a, b);
  if (version !== 0) return version;
  const provider = a.provider.localeCompare(b.provider);
  if (provider !== 0) return provider;
  return a.label.localeCompare(b.label);
}

function compareModelVersionDesc(a: ModelListItem, b: ModelListItem): number {
  const aVersion = extractVersionParts(a);
  const bVersion = extractVersionParts(b);
  if (aVersion.length === 0 || bVersion.length === 0) return 0;
  const length = Math.max(aVersion.length, bVersion.length);
  for (let i = 0; i < length; i++) {
    const diff = (bVersion[i] ?? 0) - (aVersion[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function extractVersionParts(model: ModelListItem): number[] {
  const text = `${model.modelId} ${model.label}`;
  const match = /(?:gpt|claude|gemini|glm|llama|qwen|mistral)[-\s]?([0-9]+(?:[.-][0-9]+)*)/i.exec(
    text,
  );
  if (!match?.[1]) return [];
  return match[1].split(/[.-]/).map((part) => Number(part));
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k ctx`;
  return `${tokens} ctx`;
}
