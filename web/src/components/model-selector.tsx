import { Popover } from "@base-ui/react/popover";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { ChevronDownIcon, StarIcon } from "lucide-react";
import { Fragment, memo, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/common/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { createModelSearchIndex, searchModelIndex } from "@/lib/model-search";
import type { ModelListItem, ModelsListResponse, ModelsMutationResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

const rootApi = getRouteApi("__root__");

export const MODELS_QUERY_KEY = ["models", "catalog-v3"] as const;
const THINKING_LEVELS: ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const THINKING_LEVEL_LABELS: Record<ModelThinkingLevel, string> = {
  off: "off",
  minimal: "min",
  low: "low",
  medium: "med",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export type ModelSelectorProps = {
  compact?: boolean;
  disabled?: boolean;
  piSessionId: string;
  selectedModelId?: string;
  selectedThinkingLevel?: ModelThinkingLevel;
};

export const ModelSelector = memo(function ModelSelector({
  compact,
  disabled,
  piSessionId,
  selectedModelId,
  selectedThinkingLevel,
}: ModelSelectorProps) {
  const { apiClient } = rootApi.useRouteContext();
  const [search, setSearch] = useState("");
  const searchTerm = search.trim();
  const searching = searchTerm.length >= 2;
  const { data } = useQuery({
    queryKey: MODELS_QUERY_KEY,
    queryFn: ({ signal }) => apiClient.listModels(signal),
    staleTime: 0,
  });

  const catalogPinned = data?.pinned ?? [];
  const catalogAll = data?.all ?? [];
  const initialModelIds = data?.initialModelIds ?? [];
  const initialModels = useMemo(() => {
    const modelsById = new Map([...catalogPinned, ...catalogAll].map((model) => [model.id, model]));
    return initialModelIds.flatMap((id) => {
      const model = modelsById.get(id);
      return model ? [model] : [];
    });
  }, [catalogPinned, catalogAll, initialModelIds]);
  const searchIndex = useMemo(
    () => createModelSearchIndex([...catalogPinned, ...catalogAll]),
    [catalogPinned, catalogAll],
  );
  const searchResults = useMemo(
    () => searchModelIndex(searchIndex, searchTerm),
    [searchIndex, searchTerm],
  );
  const all = searching ? searchResults : initialModels;
  const defaultModelId = data?.defaultModel ?? null;
  const defaultThinkingLevel = data?.defaultThinkingLevel ?? "high";
  const activeModelId = selectedModelId ?? defaultModelId;
  const activeThinkingLevel = selectedThinkingLevel ?? defaultThinkingLevel;
  const pinnedIds = useMemo(() => {
    const set = new Set<string>();
    for (const model of catalogPinned) {
      set.add(model.id);
      set.add(`${model.provider}/${model.modelId}`);
    }
    return set;
  }, [catalogPinned]);

  const queryClient = useQueryClient();
  const pinMutation = useMutation({
    mutationFn: ({ id, pin, label }: { id: string; pin: boolean; label?: string }) =>
      apiClient.pinModel(id, pin, label),
    onSuccess: (result, vars) => {
      updateModelsCache(queryClient, result);
      toast.success(vars.pin ? "Pinned to config" : "Unpinned");
    },
    onError: (error) => {
      toast.error(`Pin failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  const modelMutation = useMutation({
    mutationFn: (id: string) => {
      if (!piSessionId) throw new Error("No Pi session selected");
      return apiClient.setPiSessionModel(piSessionId, id);
    },
    onSuccess: (result) => {
      updateModelsCache(queryClient, result);
      queryClient.invalidateQueries({ queryKey: ["status"] });
      toast.success("Model switched");
    },
    onError: (error) => {
      toast.error(`Set model failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  const thinkingMutation = useMutation({
    mutationFn: (level: ModelThinkingLevel) => {
      if (!piSessionId) throw new Error("No Pi session selected");
      return apiClient.setPiSessionThinkingLevel(piSessionId, level);
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
      catalogPinned.find((model) => matchesModelId(model, activeModelId)) ??
      catalogAll.find((model) => matchesModelId(model, activeModelId)) ??
      undefined
    );
  }, [activeModelId, catalogPinned, catalogAll]);
  const availableThinkingLevels = useMemo(
    () => getAvailableThinkingLevels(currentModel),
    [currentModel],
  );

  const [open, setOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const modelBusy = pinMutation.isPending || modelMutation.isPending;
  const thinkingDisabled = thinkingMutation.isPending || !piSessionId;
  const firstModel = all[0];
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setSearch("");
  };

  if (catalogPinned.length === 0 && catalogAll.length === 0) {
    return null;
  }

  const triggerLabel = currentModel?.label ?? "Select model";

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger
        disabled={disabled || !piSessionId}
        render={
          <Button
            type="button"
            variant="subtle"
            size="sm"
            className={cn(
              "h-10 border-border-muted bg-background text-sm text-text-muted hover:border-border hover:bg-background-hover hover:text-text sm:h-7",
              compact ? "px-1.5" : "px-2",
            )}
            title={
              currentModel
                ? `${currentModel.label} (${currentModel.provider}/${currentModel.modelId})`
                : "Pick a model"
            }
          />
        }
      >
        <span className={cn("truncate max-w-[180px]", compact && "sr-only")}>{triggerLabel}</span>
        <ChevronDownIcon className="size-3 shrink-0" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="end"
          sideOffset={6}
          className="z-50 w-[min(420px,calc(100vw-16px))]"
        >
          <Popover.Popup
            initialFocus={searchInputRef}
            aria-label="Select model"
            className="h-[min(32rem,70vh,var(--available-height))] outline-none"
          >
            <Command
              loop
              shouldFilter={false}
              defaultValue={firstModel ? modelCommandValue(firstModel) : undefined}
              label="Search models"
              className="h-full rounded-lg border border-border bg-background text-text shadow-lg"
            >
              <CommandInput
                ref={searchInputRef}
                value={search}
                onValueChange={setSearch}
                placeholder="Search models…"
              />
              <CommandList className="max-h-none flex-1">
                <CommandGroup heading="Thinking level">
                  <div className="flex flex-wrap gap-1 p-1">
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
                  </div>
                </CommandGroup>

                {searching && all.length === 0 && (
                  <div className="px-3 py-6 text-center text-sm text-text-muted">
                    No models match.
                  </div>
                )}
                {all.length > 0 && (
                  <CommandGroup heading={searching ? "Search results" : undefined}>
                    {all.map((model, index) => {
                      const isPinned = pinnedIds.has(model.id);
                      const available = model.authKind !== "none";
                      const previousModel = all[index - 1];
                      const previousIsPinned = previousModel
                        ? pinnedIds.has(previousModel.id)
                        : false;
                      const sectionChanged =
                        !previousModel ||
                        isPinned !== previousIsPinned ||
                        (!isPinned &&
                          !previousIsPinned &&
                          available !== (previousModel.authKind !== "none"));
                      const showSectionHeading = !searching && sectionChanged;
                      const showProviderHeading =
                        !searching &&
                        !isPinned &&
                        (sectionChanged || previousModel?.provider !== model.provider);
                      return (
                        <Fragment key={`all:${model.id}`}>
                          {showSectionHeading && (
                            <div className="px-2 pb-1 pt-3 text-xs font-semibold text-text">
                              {isPinned ? "Pinned" : available ? "Available" : "Unavailable"}
                            </div>
                          )}
                          {showProviderHeading && (
                            <div className="px-2 pb-1 pt-2 text-[11px] font-medium text-text-muted">
                              {model.provider}
                            </div>
                          )}
                          <ModelCommandItem
                            model={model}
                            selected={activeModelId ? matchesModelId(model, activeModelId) : false}
                            isPinned={isPinned}
                            canUnpin={catalogPinned.length > 1}
                            onSelect={() => {
                              modelMutation.mutate(model.id);
                              handleOpenChange(false);
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
                        </Fragment>
                      );
                    })}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});

function ThinkingLevelCommandItem({
  level,
  selected,
  disabled,
  title,
  onSelect,
}: {
  level: ModelThinkingLevel;
  selected: boolean;
  disabled: boolean;
  title: string;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={`thinking ${level} ${THINKING_LEVEL_LABELS[level]}`}
      data-checked={selected}
      disabled={disabled}
      onSelect={onSelect}
      title={title}
      className={cn(
        "w-auto rounded-md border border-border-muted px-2 py-1 text-[11px] leading-none text-text-muted [&>svg]:hidden",
        "data-selected:border-border data-selected:bg-background-hover data-selected:text-text",
        "data-[checked=true]:border-border data-[checked=true]:bg-background-selected data-[checked=true]:text-text",
        "data-[checked=true]:data-selected:border-border data-[checked=true]:data-selected:bg-background-selected data-[checked=true]:data-selected:text-text",
      )}
    >
      {THINKING_LEVEL_LABELS[level]}
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
  const available = model.authKind !== "none";
  const pinDisabled = busy || (isPinned && !canUnpin);
  const pinTitle = isPinned
    ? canUnpin
      ? "Unpin from config"
      : "Keep at least one pinned model"
    : "Pin to config";

  return (
    <CommandItem
      value={modelCommandValue(model)}
      data-checked={selected}
      disabled={busy}
      aria-disabled={!available}
      onSelect={() => {
        if (available) onSelect();
      }}
      className={cn(
        "items-start py-2 [&>svg]:hidden",
        "data-selected:bg-background-hover data-selected:text-text data-[checked=true]:bg-background-selected data-[checked=true]:text-text data-[checked=true]:data-selected:bg-background-selected",
        !available && "opacity-60",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium leading-tight">{model.label}</span>
        <span className="truncate text-[11px] leading-tight text-text-muted">
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
        className="shrink-0 self-center rounded p-1 text-border-pop transition-colors hover:bg-background-hover hover:text-border-pop focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-pop disabled:cursor-not-allowed disabled:opacity-40"
        aria-label={pinTitle}
        title={pinTitle}
      >
        <StarIcon className={cn("h-3.5 w-3.5", isPinned && "fill-current")} />
      </button>
    </CommandItem>
  );
}

function modelCommandValue(model: ModelListItem): string {
  return `${model.label} ${model.provider} ${model.modelId} ${model.name ?? ""}`;
}

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
        className="shrink-0 self-center rounded bg-background-muted px-1.5 py-0.5 text-[10px] text-text-muted"
        title={`Using subscription/OAuth token auth for provider "${model.provider}"`}
      >
        subscription
      </span>
    );
  }
  if (model.authKind === "api_key") {
    return (
      <span
        className="shrink-0 self-center rounded bg-background-muted px-1.5 py-0.5 text-[10px] text-text-muted"
        title={`Using API key auth for provider "${model.provider}"`}
      >
        api key
      </span>
    );
  }
  return (
    <span
      className="shrink-0 self-center rounded bg-background-muted px-1.5 py-0.5 text-[10px] text-text-muted"
      title={`No auth configured for provider "${model.provider}"`}
    >
      no auth
    </span>
  );
}

function getAvailableThinkingLevels(model: ModelListItem | undefined): ModelThinkingLevel[] {
  if (!model) return THINKING_LEVELS;
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter(
    (level) => (level !== "xhigh" || model.supportsXhigh) && (level !== "max" || model.supportsMax),
  );
}

function updateModelsCache(queryClient: QueryClient, result: ModelsMutationResponse): void {
  queryClient.setQueryData<ModelsListResponse>(MODELS_QUERY_KEY, {
    pinned: result.pinned,
    all: result.all,
    initialModelIds: result.initialModelIds,
    defaultModel: result.defaultModel,
    defaultThinkingLevel: result.defaultThinkingLevel,
  });
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k ctx`;
  return `${tokens} ctx`;
}
