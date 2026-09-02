import { Popover } from "@base-ui/react/popover";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowRightIcon, ChevronDownIcon, StarIcon } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/common/button";
import { ShortcutHint } from "@/components/common/kbd";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useModifierLabel } from "@/hooks/platform";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";
import {
  registerShortcutHandlers,
  SHORTCUT_ACTIONS,
  useShortcutBindingLabel,
} from "@/lib/global-shortcuts";
import { createModelSearchIndex, searchModelIndex } from "@/lib/model-search";
import { handleTextInputKeyDown } from "@/lib/text-input";
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
  subdued?: boolean;
  piSessionId: string;
  selectedModelId?: string;
  selectedThinkingLevel?: ModelThinkingLevel;
};

export const ModelSelector = memo(function ModelSelector({
  compact,
  disabled,
  subdued,
  piSessionId,
  selectedModelId,
  selectedThinkingLevel,
}: ModelSelectorProps) {
  const { apiClient } = rootApi.useRouteContext();
  const modifierLabel = useModifierLabel();
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
  const defaultModelId = data?.defaultModel ?? null;
  const defaultThinkingLevel = data?.defaultThinkingLevel ?? "high";
  const activeModelId = selectedModelId ?? defaultModelId;
  const catalog = useMemo(() => [...catalogPinned, ...catalogAll], [catalogPinned, catalogAll]);
  const modelsById = useMemo(() => {
    const map = new Map<string, ModelListItem>();
    for (const model of catalogAll) map.set(model.id, model);
    for (const model of catalogPinned) map.set(model.id, model);
    return map;
  }, [catalogAll, catalogPinned]);
  const currentModel = useMemo(
    () =>
      activeModelId
        ? (modelsById.get(activeModelId) ??
          catalog.find((model) => matchesModelId(model, activeModelId)))
        : undefined,
    [activeModelId, catalog, modelsById],
  );
  const initialModels = useMemo(() => {
    const models: ModelListItem[] = [];
    const includedIds = new Set<string>();
    const includedKeys = new Set<string>();
    for (const id of initialModelIds) {
      const model = modelsById.get(id);
      if (!model || includedIds.has(model.id)) continue;
      includedIds.add(model.id);
      includedKeys.add(`${model.provider}/${model.modelId}`);
      models.push(model);
    }
    const currentKey = currentModel && `${currentModel.provider}/${currentModel.modelId}`;
    if (
      currentModel &&
      currentKey &&
      !includedIds.has(currentModel.id) &&
      !includedKeys.has(currentKey)
    ) {
      models.push(currentModel);
    }
    return models;
  }, [currentModel, initialModelIds, modelsById]);
  const searchIndex = useMemo(() => createModelSearchIndex(catalog), [catalog]);
  const searchResults = useMemo(
    () => searchModelIndex(searchIndex, searchTerm),
    [searchIndex, searchTerm],
  );
  const all = searching ? searchResults : initialModels;
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
    onSuccess: async (result, level) => {
      updateModelsCache(queryClient, result);
      toast.success(`Thinking level set to ${level}`);
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    },
    onError: (error) => {
      toast.error(`Set thinking failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  const activeThinkingLevel = thinkingMutation.isPending
    ? thinkingMutation.variables
    : (selectedThinkingLevel ?? defaultThinkingLevel);

  const availableThinkingLevels = useMemo(
    () => getAvailableThinkingLevels(currentModel),
    [currentModel],
  );

  const [open, setOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const modelBusy = pinMutation.isPending || modelMutation.isPending;
  const thinkingDisabled = !piSessionId;
  const firstModel = all[0];
  const initialCommandModel = currentModel ?? firstModel;
  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (handleTextInputKeyDown(event)) return;
    if (
      (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.repeat ||
      thinkingDisabled ||
      availableThinkingLevels.length < 2
    ) {
      return;
    }

    const direction = event.key === "ArrowRight" ? 1 : -1;
    const currentIndex = availableThinkingLevels.indexOf(activeThinkingLevel);
    const nextIndex =
      currentIndex < 0
        ? direction > 0
          ? 0
          : availableThinkingLevels.length - 1
        : (currentIndex + direction + availableThinkingLevels.length) %
          availableThinkingLevels.length;
    const nextLevel = availableThinkingLevels[nextIndex];
    if (!nextLevel || nextLevel === activeThinkingLevel) return;

    event.preventDefault();
    event.stopPropagation();
    thinkingMutation.mutate(nextLevel);
  };
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setSearch("");
  }, []);
  const handleModelSelect = useCallback(
    (id: string) => {
      modelMutation.mutate(id);
      handleOpenChange(false);
    },
    [handleOpenChange, modelMutation.mutate],
  );
  const handleTogglePin = useCallback(
    (model: ModelListItem, isPinned: boolean) => {
      pinMutation.mutate({
        id: model.id,
        pin: !isPinned,
        ...(isPinned ? {} : { label: model.name ?? model.label }),
      });
    },
    [pinMutation.mutate],
  );
  const openModelSearch = useCallback(() => {
    if (disabled || !piSessionId || (catalogPinned.length === 0 && catalogAll.length === 0)) {
      return false;
    }
    if (searchInputRef.current) {
      searchInputRef.current.focus();
    } else {
      setOpen(true);
    }
    return true;
  }, [catalogAll.length, catalogPinned.length, disabled, piSessionId]);
  const modelSearchShortcutHint = useShortcutBindingLabel(SHORTCUT_ACTIONS.modelSearch, {
    altLabel: modifierLabel,
  });
  const searchPlaceholder = modelSearchShortcutHint
    ? `Search (${modelSearchShortcutHint.replaceAll("+", " + ")})`
    : "Search";
  useWhyDidYouRender("ModelSelector", {
    compact,
    disabled,
    subdued,
    piSessionId,
    selectedModelId,
    selectedThinkingLevel,
    apiClient,
    modifierLabel,
    data,
    search,
    searching,
    open,
    all,
    activeModelId,
    activeThinkingLevel,
    availableThinkingLevels,
    modelBusy,
    thinkingDisabled,
    initialCommandValue: initialCommandModel ? modelCommandValue(initialCommandModel) : undefined,
  });
  useEffect(
    () =>
      registerShortcutHandlers([
        { actionId: SHORTCUT_ACTIONS.modelSearch, handler: openModelSearch },
        {
          actionId: SHORTCUT_ACTIONS.swimlaneSearch,
          priority: 1,
          handler: () => {
            if (open) handleOpenChange(false);
            return false;
          },
        },
      ]),
    [handleOpenChange, open, openModelSearch],
  );

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
              "group h-10 border-border-muted bg-background text-sm text-text-muted hover:border-border hover:bg-background-hover hover:text-text sm:h-7",
              subdued && "bg-transparent",
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
        <span
          className={cn(
            "truncate max-w-[180px]",
            subdued && "text-border-muted group-hover:text-text",
            compact && "sr-only",
          )}
        >
          {triggerLabel}
        </span>
        <ChevronDownIcon className={cn("size-3 shrink-0", subdued && "text-border-muted")} />
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
              shouldFilter={false}
              defaultValue={
                initialCommandModel ? modelCommandValue(initialCommandModel) : undefined
              }
              label="Search models"
              className="h-full rounded-lg border border-border bg-background text-text shadow-lg"
            >
              <div className="relative">
                <CommandInput
                  ref={searchInputRef}
                  value={search}
                  onValueChange={setSearch}
                  placeholder={searchPlaceholder}
                  className={modelSearchShortcutHint ? "pr-20" : undefined}
                  onKeyDown={handleSearchKeyDown}
                />
                {modelSearchShortcutHint && (
                  <ShortcutHint
                    label={modelSearchShortcutHint}
                    className="pointer-events-none absolute top-1 right-4 bottom-0 shrink-0"
                    kbdSize="compact"
                    aria-hidden="true"
                  />
                )}
              </div>
              <CommandGroup className="px-1 pt-1 pb-0">
                <div className="flex items-center gap-2 px-1 pb-0">
                  <div className="flex min-w-0 flex-1 flex-wrap gap-1">
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
                          onSelect={() => {
                            if (level !== activeThinkingLevel) thinkingMutation.mutate(level);
                          }}
                        />
                      );
                    })}
                  </div>
                  <div
                    className="mr-1.5 flex shrink-0 items-center gap-1 self-center"
                    aria-label="Use Left Arrow or Right Arrow to switch thinking level"
                  >
                    <span className="text-[10px] text-text-muted" aria-hidden="true">
                      switch
                    </span>
                    <kbd
                      className="inline-flex size-4 items-center justify-center rounded border border-border-muted bg-background-muted text-text-muted"
                      aria-hidden="true"
                    >
                      <ArrowLeftIcon className="size-2.5" />
                    </kbd>
                    <kbd
                      className="inline-flex size-4 items-center justify-center rounded border border-border-muted bg-background-muted text-text-muted"
                      aria-hidden="true"
                    >
                      <ArrowRightIcon className="size-2.5" />
                    </kbd>
                  </div>
                </div>
              </CommandGroup>
              <ModelCommandList
                models={all}
                searching={searching}
                pinnedIds={pinnedIds}
                activeModelId={activeModelId}
                canUnpin={catalogPinned.length > 1}
                busy={modelBusy}
                onSelectModel={handleModelSelect}
                onTogglePin={handleTogglePin}
              />
            </Command>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});

const ModelCommandList = memo(function ModelCommandList({
  models,
  searching,
  pinnedIds,
  activeModelId,
  canUnpin,
  busy,
  onSelectModel,
  onTogglePin,
}: {
  models: ModelListItem[];
  searching: boolean;
  pinnedIds: Set<string>;
  activeModelId: string | null;
  canUnpin: boolean;
  busy: boolean;
  onSelectModel: (id: string) => void;
  onTogglePin: (model: ModelListItem, isPinned: boolean) => void;
}) {
  return (
    <CommandList className="max-h-none flex-1">
      {searching && models.length === 0 && (
        <div className="px-3 py-6 text-center text-sm text-text-muted">No models match.</div>
      )}
      {models.length > 0 && (
        <CommandGroup
          heading={searching ? "Search results" : undefined}
          className="pt-1 **:[[cmdk-group-heading]]:pt-1.5 **:[[cmdk-group-heading]]:pb-0.5"
        >
          {models.map((model, index) => {
            const isPinned = pinnedIds.has(model.id);
            const available = model.authKind !== "none";
            const previousModel = models[index - 1];
            const previousIsPinned = previousModel ? pinnedIds.has(previousModel.id) : false;
            const catalogueGroupChanged =
              !previousModel ||
              isPinned !== previousIsPinned ||
              (!isPinned && !previousIsPinned && available !== (previousModel.authKind !== "none"));
            const showProviderHeading =
              !searching &&
              !isPinned &&
              (catalogueGroupChanged || previousModel?.provider !== model.provider);
            return (
              <Fragment key={`all:${model.id}`}>
                {showProviderHeading && (
                  <div className="border-border-muted border-t px-2 pt-1.25 text-xs font-medium text-text-pop truncate">
                    Provider: {model.provider}
                  </div>
                )}
                <ModelCommandItem
                  model={model}
                  selected={activeModelId ? matchesModelId(model, activeModelId) : false}
                  isPinned={isPinned}
                  canUnpin={canUnpin}
                  onSelect={() => onSelectModel(model.id)}
                  onTogglePin={() => onTogglePin(model, isPinned)}
                  busy={busy}
                />
              </Fragment>
            );
          })}
        </CommandGroup>
      )}
    </CommandList>
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
    <button
      type="button"
      data-checked={selected}
      aria-pressed={selected}
      disabled={disabled}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onSelect}
      title={title}
      className={cn(
        "w-auto cursor-default rounded-md border border-border-muted px-2 py-1 text-[11px] leading-none text-text-muted outline-none disabled:pointer-events-none disabled:opacity-50",
        "hover:border-border hover:bg-background-hover hover:text-text focus-visible:border-border focus-visible:bg-background-hover focus-visible:text-text",
        "data-[checked=true]:border-border data-[checked=true]:bg-background-selected data-[checked=true]:text-text",
      )}
    >
      {THINKING_LEVEL_LABELS[level]}
    </button>
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
  return `${model.id} ${model.provider}/${model.modelId} ${model.label}`.trim();
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
        className="shrink-0 self-center rounded border border-border-muted bg-background-muted px-1.5 py-0.5 text-[10px] text-text-muted"
        title={`Using subscription/OAuth token auth for provider "${model.provider}"`}
      >
        subscription
      </span>
    );
  }
  if (model.authKind === "api_key") {
    return (
      <span
        className="shrink-0 self-center rounded border border-border-muted bg-background-muted px-1.5 py-0.5 text-[10px] text-text-muted"
        title={`Using API key auth for provider "${model.provider}"`}
      >
        api key
      </span>
    );
  }
  return (
    <span
      className="shrink-0 self-center rounded border border-border-muted bg-background-muted px-1.5 py-0.5 text-[10px] text-text-muted"
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
