import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { ChevronDownIcon, StarIcon } from "lucide-react";
import {
  type CSSProperties,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Button } from "~/components/common/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "~/components/ui/command";
import type {
  ModelListItem,
  ModelsListResponse,
  ModelsMutationResponse,
  ThinkingLevel,
} from "~/lib/types";
import { cn } from "~/lib/utils";

const rootApi = getRouteApi("__root__");

const MODELS_QUERY_KEY = ["models", "auth-kind-v2"] as const;
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "off",
  minimal: "min",
  low: "low",
  medium: "med",
  high: "high",
  xhigh: "xhigh",
};

export type ModelSelectorProps = {
  /** Compact mode hides the label text in the trigger, showing only the chevron. */
  compact?: boolean;
  disabled?: boolean;
  /** Default mode updates config and the live default Pi session. Pi-session mode only changes that session. */
  mode?: "default" | "pi-session";
  piSessionId?: string;
  selectedModelId?: string;
  selectedThinkingLevel?: ThinkingLevel;
};

/**
 * Dropdown that sits next to the composer's send button. Shows two sections:
 *
 *   1. *Pinned* — the curated shortlist from `config.models[]`.
 *   2. *All models* — the full pi SDK catalog, grouped by provider, with a
 *      type-to-filter search. Entries whose provider has no auth configured
 *      are rendered dimmed with a small badge.
 *
 * Selecting a model either updates the default model (default route) or switches
 * the currently viewed Pi session (stream route).
 */
export const ModelSelector = memo(function ModelSelector({
  compact,
  disabled,
  mode = "default",
  piSessionId,
  selectedModelId,
  selectedThinkingLevel,
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
  const defaultThinkingLevel = data?.defaultThinkingLevel ?? "high";
  const activeModelId = selectedModelId ?? defaultModelId;
  const activeThinkingLevel = selectedThinkingLevel ?? defaultThinkingLevel;
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
      // The mutation response is the same derived model-list shape as GET, so
      // the cache keeps the server invariant: pinned catalog entries are absent
      // from `all` instead of being deduped again in the render path.
      updateModelsCache(queryClient, result);
      toast.success(vars.pin ? "Pinned to config" : "Unpinned");
    },
    onError: (error) => {
      toast.error(`Pin failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  const modelMutation = useMutation({
    mutationFn: (id: string) => {
      if (mode === "pi-session") {
        if (!piSessionId) throw new Error("No Pi session selected");
        return apiClient.setPiSessionModel(piSessionId, id);
      }
      return apiClient.setDefaultModel(id);
    },
    onSuccess: (result) => {
      updateModelsCache(queryClient, result);
      queryClient.invalidateQueries({ queryKey: ["status"] });
      toast.success(mode === "pi-session" ? "Stream model switched" : "Default model updated");
    },
    onError: (error) => {
      toast.error(`Set model failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  const thinkingMutation = useMutation({
    mutationFn: (level: ThinkingLevel) => {
      if (mode === "pi-session") {
        if (!piSessionId) throw new Error("No Pi session selected");
        return apiClient.setPiSessionThinkingLevel(piSessionId, level);
      }
      return apiClient.setDefaultThinkingLevel(level);
    },
    onSuccess: (result, level) => {
      updateModelsCache(queryClient, result);
      queryClient.invalidateQueries({ queryKey: ["status"] });
      toast.success(`Thinking level set to ${level}`);
    },
    onError: (error) => {
      toast.error(`Set thinking failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  });

  const currentModel = useMemo(() => {
    if (!activeModelId) return undefined;
    return (
      pinned.find((m) => matchesModelId(m, activeModelId)) ??
      all.find((m) => matchesModelId(m, activeModelId)) ??
      undefined
    );
  }, [activeModelId, pinned, all]);
  const availableThinkingLevels = useMemo(
    () => getAvailableThinkingLevels(currentModel),
    [currentModel],
  );

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const groupedAll = useMemo(() => groupByAuthKind(all), [all]);
  const modelBusy = pinMutation.isPending || modelMutation.isPending;
  const thinkingDisabled = thinkingMutation.isPending || (mode === "pi-session" && !piSessionId);

  const updatePopoverPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = 420;
    setPopoverStyle({
      position: "fixed",
      top: rect.bottom + 6,
      left: Math.max(8, rect.right - width),
      width,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePopoverPosition();
  }, [open, updatePopoverPosition]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, updatePopoverPosition]);

  if (pinned.length === 0 && all.length === 0) {
    return null;
  }

  const triggerLabel = currentModel?.label ?? "Select model";

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || (mode === "pi-session" && !piSessionId)}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "h-10 sm:h-7 border-border/60 bg-background/40 text-xs text-muted-foreground hover:bg-accent/50 hover:border-border",
          compact ? "px-1.5" : "px-2",
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          currentModel
            ? `${currentModel.label} (${currentModel.provider}/${currentModel.modelId})`
            : "Pick a model"
        }
      >
        <span className={cn("truncate max-w-[180px]", compact && "sr-only")}>{triggerLabel}</span>
        <ChevronDownIcon className="h-3 w-3 shrink-0" />
      </Button>
      {open &&
        createPortal(
          <div ref={popoverRef} className="z-50" style={popoverStyle}>
            <Command
              loop
              className="h-[min(70vh,32rem)] rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
            >
              <CommandInput placeholder="Search models…" autoFocus />
              <CommandList className="max-h-none flex-1">
                <CommandEmpty>No models match.</CommandEmpty>
                <CommandGroup heading="Thinking level">
                  {THINKING_LEVELS.map((level) => {
                    const levelAvailable = availableThinkingLevels.includes(level);
                    return (
                      <ThinkingLevelCommandItem
                        key={level}
                        level={level}
                        selected={level === activeThinkingLevel}
                        disabled={thinkingDisabled || !levelAvailable}
                        title={
                          levelAvailable
                            ? `Set thinking level to ${level}`
                            : "Current model does not support this level"
                        }
                        onSelect={() => thinkingMutation.mutate(level)}
                      />
                    );
                  })}
                </CommandGroup>

                {pinned.length > 0 && (
                  <>
                    <CommandSeparator />
                    <CommandGroup heading="Pinned">
                      {pinned.map((model) => (
                        <ModelCommandItem
                          key={`pinned:${model.id}`}
                          model={model}
                          selected={activeModelId ? matchesModelId(model, activeModelId) : false}
                          isPinned
                          canUnpin={pinned.length > 1}
                          onSelect={() => {
                            modelMutation.mutate(model.id);
                            setOpen(false);
                          }}
                          onTogglePin={() => pinMutation.mutate({ id: model.id, pin: false })}
                          busy={modelBusy}
                        />
                      ))}
                    </CommandGroup>
                  </>
                )}

                {groupedAll.map(([section, models]) => (
                  <CommandGroup key={section} heading={section}>
                    {models.map((model) => {
                      const isPinned = pinnedIds.has(model.id);
                      return (
                        <ModelCommandItem
                          key={`all:${model.id}`}
                          model={model}
                          selected={activeModelId ? matchesModelId(model, activeModelId) : false}
                          isPinned={isPinned}
                          canUnpin={pinned.length > 1}
                          onSelect={() => {
                            modelMutation.mutate(model.id);
                            setOpen(false);
                          }}
                          onTogglePin={() =>
                            pinMutation.mutate({
                              id: model.id,
                              pin: !isPinned,
                              ...(isPinned ? {} : { label: model.name ?? model.label }),
                            })
                          }
                          busy={modelBusy}
                        />
                      );
                    })}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
          </div>,
          document.body,
        )}
    </>
  );
});

function ThinkingLevelCommandItem({
  level,
  selected,
  disabled,
  title,
  onSelect,
}: {
  level: ThinkingLevel;
  selected: boolean;
  disabled: boolean;
  title: string;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={`thinking ${level} ${THINKING_LEVEL_LABELS[level]}`}
      data-checked={selected}
      disabled={disabled || selected}
      onSelect={onSelect}
      title={title}
    >
      <span className={cn("font-medium", selected && "text-primary")}>{level}</span>
      <CommandShortcut>{selected ? "current" : THINKING_LEVEL_LABELS[level]}</CommandShortcut>
    </CommandItem>
  );
}

function ModelCommandItem({
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
    <CommandItem
      value={`${model.label} ${model.provider} ${model.modelId} ${model.name ?? ""}`}
      data-checked={selected}
      disabled={busy}
      onSelect={onSelect}
      className={cn("items-start py-2", !available && "opacity-60")}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium leading-tight">{model.label}</span>
        <span className="truncate text-[11px] leading-tight text-muted-foreground/70">
          {model.provider} · {model.modelId}
          {model.contextWindow ? ` · ${formatContext(model.contextWindow)}` : ""}
          {model.thinkingLevel ? ` · thinking=${model.thinkingLevel}` : ""}
        </span>
      </div>
      <AuthBadge model={model} />
      <button
        type="button"
        disabled={pinDisabled}
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onTogglePin();
        }}
        className={cn(
          "shrink-0 self-center rounded p-1 transition-colors",
          "text-muted-foreground/50 hover:bg-accent hover:text-foreground",
          "disabled:cursor-not-allowed disabled:opacity-40",
          isPinned && "text-amber-500/80 hover:text-amber-500",
        )}
        title={pinTitle}
      >
        <StarIcon className={cn("h-3.5 w-3.5", isPinned && "fill-current")} />
      </button>
    </CommandItem>
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

function getAvailableThinkingLevels(model: ModelListItem | undefined): ThinkingLevel[] {
  if (!model) return THINKING_LEVELS;
  if (!model.reasoning) return ["off"];
  return model.supportsXhigh
    ? THINKING_LEVELS
    : THINKING_LEVELS.filter((level) => level !== "xhigh");
}

function updateModelsCache(queryClient: QueryClient, result: ModelsMutationResponse): void {
  queryClient.setQueryData<ModelsListResponse>(MODELS_QUERY_KEY, {
    pinned: result.pinned,
    all: result.all,
    defaultModel: result.defaultModel,
    defaultThinkingLevel: result.defaultThinkingLevel,
  });
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k ctx`;
  return `${tokens} ctx`;
}
