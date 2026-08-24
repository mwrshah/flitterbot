import { layoutWithLines, prepareWithSegments } from "@chenglou/pretext";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  type KeyboardEvent,
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FloatingCommandPickerPlacement } from "@/components/common/floating-command-picker";
import { PathPicker } from "@/components/path-picker";
import { SkillPicker } from "@/components/skill-picker";
import { getInternalCommandsForScope, type InternalCommandScope } from "@/lib/internal-commands";
import { directoryCompletionsQueryOptions, skillsQueryOptions } from "@/lib/queries";
import type { DirectoryCompletionItem, SkillPickerItem } from "@/lib/types";

const EMPTY_PATH_ITEMS: DirectoryCompletionItem[] = [];
const rootRouteApi = getRouteApi("__root__");

function autoExpandedDuplicateSlashIndex(filter: string) {
  if (filter.startsWith("@//")) return 2;
  if (filter.startsWith("..//")) return 3;

  const nestedDotDot = "/..//";
  const nestedIndex = filter.lastIndexOf(nestedDotDot);
  return nestedIndex >= 0 ? nestedIndex + nestedDotDot.length - 1 : -1;
}

function collapseSingleFollowingSpace(value: string) {
  if (value[0] !== " ") return value;
  const next = value[1];
  if (next !== undefined && /\s/.test(next)) return value;
  return value.slice(1);
}

function normalizePathPickerRemainder(inserted: string, remainder: string) {
  if (inserted.endsWith("/") && remainder.startsWith(" /"))
    return { value: remainder.slice(2), closesPicker: true };
  if (inserted.endsWith(" ") && remainder.startsWith(" "))
    return { value: remainder.slice(1), closesPicker: true };
  return { value: remainder, closesPicker: false };
}

function filterSkillsForPicker(skills: SkillPickerItem[], filter: string) {
  const lower = filter.toLowerCase();
  const matched = filter
    ? skills.filter((skill) => skill.name.toLowerCase().includes(lower))
    : skills;
  const nonCommands: SkillPickerItem[] = [];
  const commands: SkillPickerItem[] = [];
  for (const item of matched) {
    (item.kind === "command" ? commands : nonCommands).push(item);
  }
  const compare = (a: SkillPickerItem, b: SkillPickerItem) => {
    const aStarts = a.name.toLowerCase().startsWith(lower);
    const bStarts = b.name.toLowerCase().startsWith(lower);
    if (aStarts !== bStarts) return aStarts ? -1 : 1;
    return a.name.length - b.name.length;
  };
  if (filter) {
    nonCommands.sort(compare);
    commands.sort(compare);
  }
  return [...nonCommands, ...commands];
}

function samePathQueryOptions(
  current: TextareaCompletionPathQueryOptions | undefined,
  next: TextareaCompletionPathQueryOptions | undefined,
) {
  return current?.baseCwd === next?.baseCwd && current?.directoriesOnly === next?.directoriesOnly;
}

export type TextareaCompletionPathQueryOptions = {
  baseCwd?: string;
  directoriesOnly?: boolean;
};

export type TextareaCompletionMatch = {
  kind: "path" | "skill";
  triggerIndex: number;
  filter?: string;
  tokenEnd?: number;
  pathQueryOptions?: TextareaCompletionPathQueryOptions;
};

export type TextareaCompletionTriggerContext = {
  value: string;
  cursor: number;
  trigger: "/" | "@";
  triggerIndex: number;
};

export type TextareaCompletionSelectionContext = {
  value: string;
  cursor: number;
};

export type TextareaCompletionPlugin = {
  resolveTrigger: (context: TextareaCompletionTriggerContext) => TextareaCompletionMatch | null;
  continueMatch?: (
    context: TextareaCompletionSelectionContext,
    activeMatch: TextareaCompletionMatch,
  ) => TextareaCompletionMatch | null;
  resolveSelection?: (
    context: TextareaCompletionSelectionContext,
  ) => TextareaCompletionMatch | null;
  filterSkill?: (skill: SkillPickerItem) => boolean;
  formatSkillInsertion?: (skill: SkillPickerItem) => string;
  formatPathInsertion?: (item: DirectoryCompletionItem) => string;
};

export type UseTextareaCompletionsOptions = {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  anchorRef: RefObject<HTMLElement | null>;
  valueRef: RefObject<string>;
  setValue: (value: string) => void;
  onBeforeValueChange?: () => void;
  internalCommandScope?: InternalCommandScope;
  plugin?: TextareaCompletionPlugin;
  preferredPlacement?: FloatingCommandPickerPlacement;
  streamId?: string;
};

export type TextareaCompletionController = {
  handleValueChange: (rawValue: string, inputEvent?: InputEvent) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  activateAtSelection: () => boolean;
  dismiss: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  caretLeft: number;
  preferredPlacement?: FloatingCommandPickerPlacement;
  skillPicker: {
    open: boolean;
    items: SkillPickerItem[];
    onSelect: (skill: SkillPickerItem) => void;
    onEscape: () => void;
    commandRef: RefObject<HTMLDivElement | null>;
  };
  pathPicker: {
    open: boolean;
    items: DirectoryCompletionItem[];
    onSelect: (item: DirectoryCompletionItem) => void;
    onEscape: () => void;
    commandRef: RefObject<HTMLDivElement | null>;
  };
};

export function useTextareaCompletions({
  textareaRef,
  anchorRef,
  valueRef,
  setValue,
  onBeforeValueChange,
  internalCommandScope,
  plugin,
  preferredPlacement,
  streamId,
}: UseTextareaCompletionsOptions): TextareaCompletionController {
  const { apiClient } = rootRouteApi.useRouteContext();
  const { data: baseSkills } = useQuery(skillsQueryOptions(apiClient));
  const skills = useMemo(() => {
    const contextualCommands = (
      internalCommandScope ? getInternalCommandsForScope(internalCommandScope) : []
    ).filter((command) => !(baseSkills ?? []).some((skill) => skill.name === command.name));
    const items = [...(baseSkills ?? []), ...contextualCommands];
    return plugin?.filterSkill ? items.filter(plugin.filterSkill) : items;
  }, [baseSkills, internalCommandScope, plugin]);

  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillPickerFilter, setSkillPickerFilter] = useState("");
  const [caretLeft, setCaretLeft] = useState(0);
  const slashPositionRef = useRef(-1);
  const skillCommandRef = useRef<HTMLDivElement>(null);

  const [pathPickerOpen, setPathPickerOpen] = useState(false);
  const [pathPickerFilter, setPathPickerFilter] = useState("");
  const pathCommandRef = useRef<HTMLDivElement>(null);
  const atPositionRef = useRef(-1);
  const tildeExpandedRef = useRef(false);
  const dotDotExpandedRef = useRef(false);
  const activePluginMatchRef = useRef<TextareaCompletionMatch | null>(null);
  const [pathQueryOptions, setPathQueryOptions] = useState<TextareaCompletionPathQueryOptions>();

  const [debouncedPathFilter, setDebouncedPathFilter] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedPathFilter(pathPickerFilter), 150);
    return () => clearTimeout(id);
  }, [pathPickerFilter]);

  const { data: pathResult } = useQuery(
    directoryCompletionsQueryOptions(debouncedPathFilter, pathPickerOpen, {
      streamId,
      ...pathQueryOptions,
    }),
  );
  const filteredSkills = useMemo(
    () => filterSkillsForPicker(skills, skillPickerFilter),
    [skills, skillPickerFilter],
  );
  const pathPickerItems = pathResult?.items ?? EMPTY_PATH_ITEMS;
  const skillPickerVisible = skillPickerOpen && filteredSkills.length > 0;
  const pathPickerVisible = pathPickerOpen && pathPickerItems.length > 0;

  const queryClient = useQueryClient();
  useEffect(() => {
    if (plugin) return;
    queryClient.prefetchQuery(
      directoryCompletionsQueryOptions("", true, { streamId, ...pathQueryOptions }),
    );
  }, [pathQueryOptions, plugin, queryClient, streamId]);

  const refocusTextarea = useCallback(() => {
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [textareaRef]);

  const closeSkillPicker = useCallback(() => {
    setSkillPickerOpen(false);
    slashPositionRef.current = -1;
    activePluginMatchRef.current = null;
    refocusTextarea();
  }, [refocusTextarea]);

  const closePathPicker = useCallback(() => {
    setPathPickerOpen(false);
    atPositionRef.current = -1;
    tildeExpandedRef.current = false;
    dotDotExpandedRef.current = false;
    activePluginMatchRef.current = null;
    setPathQueryOptions(undefined);
    refocusTextarea();
  }, [refocusTextarea]);

  const closeActivePicker = useCallback(() => {
    if (pathPickerOpen || atPositionRef.current >= 0) {
      closePathPicker();
      return true;
    }
    if (skillPickerOpen || slashPositionRef.current >= 0) {
      closeSkillPicker();
      return true;
    }
    return false;
  }, [closePathPicker, closeSkillPicker, pathPickerOpen, skillPickerOpen]);

  const dismiss = useCallback(() => {
    setSkillPickerOpen(false);
    setPathPickerOpen(false);
    slashPositionRef.current = -1;
    atPositionRef.current = -1;
    activePluginMatchRef.current = null;
    setPathQueryOptions(undefined);
  }, []);

  const computeTriggerLeft = useCallback(
    (value: string, triggerIndex: number) => {
      const textarea = textareaRef.current;
      const anchor = anchorRef.current;
      if (!textarea || !anchor || triggerIndex < 0) return;

      const style = window.getComputedStyle(textarea);
      const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const paddingLeft = Number.parseFloat(style.paddingLeft);
      const paddingRight = Number.parseFloat(style.paddingRight);
      const contentWidth = textarea.offsetWidth - paddingLeft - paddingRight;
      const lineHeight = Number.parseFloat(style.lineHeight);
      const textThroughTrigger = value.slice(0, triggerIndex + 1);
      const prepared = prepareWithSegments(textThroughTrigger, font, { whiteSpace: "pre-wrap" });
      const result = layoutWithLines(prepared, contentWidth, lineHeight);
      const lastLine = result.lines[result.lines.length - 1];
      const xOffset = lastLine ? lastLine.width : 0;

      setCaretLeft(Math.max(0, paddingLeft + xOffset));
    },
    [anchorRef, textareaRef],
  );

  const applyPluginMatch = useCallback(
    (value: string, cursor: number, match: TextareaCompletionMatch | null) => {
      if (!match) {
        dismiss();
        return false;
      }

      const previousMatch = activePluginMatchRef.current;
      const pathWasActive = previousMatch?.kind === "path";
      activePluginMatchRef.current = match;
      if (previousMatch?.triggerIndex !== match.triggerIndex || previousMatch.kind !== match.kind) {
        computeTriggerLeft(value, match.triggerIndex);
      }
      const filter = match.filter ?? value.slice(match.triggerIndex + 1, cursor);
      if (match.kind === "path") {
        atPositionRef.current = match.triggerIndex;
        setPathPickerOpen(true);
        setPathPickerFilter(filter);
        if (!pathWasActive) setDebouncedPathFilter(filter);
        setPathQueryOptions((current) =>
          samePathQueryOptions(current, match.pathQueryOptions) ? current : match.pathQueryOptions,
        );
        slashPositionRef.current = -1;
        setSkillPickerOpen(false);
      } else {
        slashPositionRef.current = match.triggerIndex;
        setSkillPickerOpen(true);
        setSkillPickerFilter(filter);
        atPositionRef.current = -1;
        setPathPickerOpen(false);
        setPathQueryOptions(undefined);
      }
      return true;
    },
    [computeTriggerLeft, dismiss],
  );

  const handleValueChange = useCallback(
    (rawValue: string, inputEvent?: InputEvent) => {
      onBeforeValueChange?.();
      let value = rawValue;
      const cursor = textareaRef.current?.selectionStart ?? value.length;
      const typedTrigger =
        inputEvent?.inputType === "insertText" &&
        (inputEvent.data === "/" || inputEvent.data === "@")
          ? inputEvent.data
          : null;
      const triggerBeforeCursor = cursor - 1;
      const typedTriggerBeforeText =
        !plugin &&
        typedTrigger !== null &&
        value.charAt(triggerBeforeCursor) === typedTrigger &&
        /\S/.test(value.charAt(cursor)) &&
        (triggerBeforeCursor === 0 || /\s/.test(value.charAt(triggerBeforeCursor - 1)));
      if (typedTriggerBeforeText) {
        value = `${value.slice(0, cursor)} ${value.slice(cursor)}`;
        requestAnimationFrame(() => {
          textareaRef.current?.setSelectionRange(cursor, cursor);
        });
      }
      setValue(value);

      if (plugin) {
        const activeMatch = activePluginMatchRef.current;
        if (!typedTrigger && !activeMatch) return;

        let match = activeMatch
          ? (plugin.continueMatch?.({ value, cursor }, activeMatch) ?? null)
          : null;
        if (activeMatch && !plugin.continueMatch) {
          const activeTrigger = value[activeMatch.triggerIndex];
          if (activeTrigger === "/" || activeTrigger === "@") {
            match = plugin.resolveTrigger({
              value,
              cursor,
              trigger: activeTrigger,
              triggerIndex: activeMatch.triggerIndex,
            });
          }
        }
        if (!match && typedTrigger) {
          match = plugin.resolveTrigger({
            value,
            cursor,
            trigger: typedTrigger,
            triggerIndex: cursor - 1,
          });
        }
        applyPluginMatch(value, cursor, match);
        return;
      }

      let slashIndex = -1;
      for (let index = cursor - 1; index >= 0; index--) {
        const character = value[index];
        if (character === "/") {
          if (index === 0 || /\s/.test(value[index - 1]!)) slashIndex = index;
          break;
        }
        if (/\s/.test(character!)) break;
      }

      let atIndex = -1;
      for (let index = cursor - 1; index >= 0; index--) {
        const character = value[index];
        if (character === "@") {
          if (index === 0 || /\s/.test(value[index - 1]!)) atIndex = index;
          break;
        }
        if (/\s/.test(character!)) break;
      }

      if (atIndex >= 0) {
        const filter = value.slice(atIndex + 1, cursor);

        if (filter === "~" && !tildeExpandedRef.current) {
          tildeExpandedRef.current = true;
          const newValue = `${value.slice(0, cursor)}/${value.slice(cursor)}`;
          const newCursor = cursor + 1;
          setValue(newValue);
          atPositionRef.current = atIndex;
          computeTriggerLeft(newValue, atIndex);
          setPathPickerOpen(true);
          setPathPickerFilter("@/");
          slashPositionRef.current = -1;
          setSkillPickerOpen(false);
          requestAnimationFrame(() => {
            textareaRef.current?.setSelectionRange(newCursor, newCursor);
          });
          return;
        }

        if (!filter.startsWith("~")) tildeExpandedRef.current = false;

        const trailingDotDot = filter === ".." || filter.endsWith("/..");
        if (trailingDotDot && !dotDotExpandedRef.current) {
          dotDotExpandedRef.current = true;
          const newValue = `${value.slice(0, cursor)}/${value.slice(cursor)}`;
          const newCursor = cursor + 1;
          setValue(newValue);
          atPositionRef.current = atIndex;
          computeTriggerLeft(newValue, atIndex);
          setPathPickerOpen(true);
          setPathPickerFilter(`${filter}/`);
          slashPositionRef.current = -1;
          setSkillPickerOpen(false);
          requestAnimationFrame(() => {
            textareaRef.current?.setSelectionRange(newCursor, newCursor);
          });
          return;
        }
        if (!trailingDotDot) dotDotExpandedRef.current = false;

        const extraSlash = autoExpandedDuplicateSlashIndex(filter);
        if (extraSlash >= 0) {
          const extra = atIndex + 1 + extraSlash;
          const newValue = value.slice(0, extra) + value.slice(extra + 1);
          const newCursor = cursor - 1;
          setValue(newValue);
          atPositionRef.current = atIndex;
          computeTriggerLeft(newValue, atIndex);
          setPathPickerOpen(true);
          setPathPickerFilter(filter.slice(0, extraSlash) + filter.slice(extraSlash + 1));
          slashPositionRef.current = -1;
          setSkillPickerOpen(false);
          requestAnimationFrame(() => {
            textareaRef.current?.setSelectionRange(newCursor, newCursor);
          });
          return;
        }

        atPositionRef.current = atIndex;
        computeTriggerLeft(value, atIndex);
        setPathPickerOpen(true);
        setPathPickerFilter(filter);
        slashPositionRef.current = -1;
        setSkillPickerOpen(false);
      } else if (slashIndex >= 0 && skills.length) {
        const filter = value.slice(slashIndex + 1, cursor);
        slashPositionRef.current = slashIndex;
        computeTriggerLeft(value, slashIndex);
        setSkillPickerOpen(true);
        setSkillPickerFilter(filter);
        atPositionRef.current = -1;
        setPathPickerOpen(false);
      } else {
        slashPositionRef.current = -1;
        setSkillPickerOpen(false);
        atPositionRef.current = -1;
        setPathPickerOpen(false);
        tildeExpandedRef.current = false;
        dotDotExpandedRef.current = false;
      }
    },
    [
      applyPluginMatch,
      computeTriggerLeft,
      onBeforeValueChange,
      plugin,
      setValue,
      skills,
      textareaRef,
    ],
  );

  const activateAtSelection = useCallback(() => {
    if (!plugin?.resolveSelection) return false;
    const textarea = textareaRef.current;
    if (!textarea) return false;

    const value = valueRef.current;
    const cursor = textarea.selectionStart ?? value.length;
    const activeMatch = activePluginMatchRef.current;
    let match: TextareaCompletionMatch | null = null;
    if (activeMatch) {
      match = plugin.continueMatch?.({ value, cursor }, activeMatch) ?? null;
      if (!plugin.continueMatch) {
        const activeTrigger = value[activeMatch.triggerIndex];
        if (activeTrigger === "/" || activeTrigger === "@") {
          match = plugin.resolveTrigger({
            value,
            cursor,
            trigger: activeTrigger,
            triggerIndex: activeMatch.triggerIndex,
          });
        }
      }
    }
    match ??= plugin.resolveSelection({ value, cursor });
    return applyPluginMatch(value, cursor, match);
  }, [applyPluginMatch, plugin, textareaRef, valueRef]);

  const handleSkillSelect = useCallback(
    (skill: SkillPickerItem) => {
      const value = valueRef.current;
      const slashIndex = slashPositionRef.current;
      const activeMatch = activePluginMatchRef.current;
      let tokenEnd = activeMatch?.kind === "skill" ? activeMatch.tokenEnd : undefined;
      if (tokenEnd === undefined) {
        tokenEnd = slashIndex + 1;
        while (tokenEnd < value.length && !/\s/.test(value[tokenEnd]!)) tokenEnd++;
      }
      const before = value.slice(0, slashIndex);
      const after = collapseSingleFollowingSpace(value.slice(tokenEnd));
      const inserted =
        plugin?.formatSkillInsertion?.(skill) ??
        (skill.kind === "command" ? `/${skill.name} ` : `/skill:${skill.name} `);
      const newValue = before + inserted + after;
      setValue(newValue);
      setSkillPickerOpen(false);
      slashPositionRef.current = -1;
      activePluginMatchRef.current = null;
      const newCursor = before.length + inserted.length;
      requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(newCursor, newCursor);
        textareaRef.current?.focus();
      });
    },
    [plugin, setValue, textareaRef, valueRef],
  );

  const handlePathSelect = useCallback(
    (item: DirectoryCompletionItem) => {
      const value = valueRef.current;
      const atIndex = atPositionRef.current;
      const activeMatch = activePluginMatchRef.current;
      let tokenEnd = activeMatch?.kind === "path" ? activeMatch.tokenEnd : undefined;
      if (tokenEnd === undefined) {
        tokenEnd = atIndex + 1;
        while (tokenEnd < value.length && !/\s/.test(value[tokenEnd]!)) tokenEnd++;
      }
      const before = value.slice(0, atIndex);
      const isDirectory = item.kind === "directory";
      const inserted =
        plugin?.formatPathInsertion?.(item) ?? `@${item.insertText}${isDirectory ? "" : " "}`;
      const remainder = normalizePathPickerRemainder(inserted, value.slice(tokenEnd));
      const newValue = before + inserted + remainder.value;
      setValue(newValue);
      if (!isDirectory || remainder.closesPicker) closePathPicker();
      const newCursor = before.length + inserted.length;
      requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(newCursor, newCursor);
        textareaRef.current?.focus();
        if (isDirectory && !remainder.closesPicker) handleValueChange(newValue);
      });
    },
    [closePathPicker, handleValueChange, plugin, setValue, textareaRef, valueRef],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        if (!closeActivePicker()) return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
      }

      if (event.key === "Enter" && event.shiftKey && closeActivePicker()) return true;

      const navigationKeys = ["ArrowDown", "ArrowUp", "Enter", "Tab", "Home", "End"];
      if (
        skillPickerVisible &&
        slashPositionRef.current >= 0 &&
        navigationKeys.includes(event.key)
      ) {
        event.preventDefault();
        skillCommandRef.current?.dispatchEvent(
          new globalThis.KeyboardEvent("keydown", {
            key: event.key === "Tab" ? "Enter" : event.key,
            bubbles: true,
          }),
        );
        return true;
      }
      if (pathPickerVisible && atPositionRef.current >= 0 && navigationKeys.includes(event.key)) {
        event.preventDefault();
        pathCommandRef.current?.dispatchEvent(
          new globalThis.KeyboardEvent("keydown", {
            key: event.key === "Tab" ? "Enter" : event.key,
            bubbles: true,
          }),
        );
        return true;
      }
      return false;
    },
    [closeActivePicker, pathPickerVisible, skillPickerVisible],
  );

  return useMemo(
    () => ({
      handleValueChange,
      handleKeyDown,
      activateAtSelection,
      dismiss,
      anchorRef,
      caretLeft,
      preferredPlacement,
      skillPicker: {
        open: skillPickerVisible,
        items: filteredSkills,
        onSelect: handleSkillSelect,
        onEscape: closeSkillPicker,
        commandRef: skillCommandRef,
      },
      pathPicker: {
        open: pathPickerVisible,
        items: pathPickerItems,
        onSelect: handlePathSelect,
        onEscape: closePathPicker,
        commandRef: pathCommandRef,
      },
    }),
    [
      anchorRef,
      activateAtSelection,
      caretLeft,
      closePathPicker,
      closeSkillPicker,
      dismiss,
      filteredSkills,
      handleKeyDown,
      handlePathSelect,
      handleSkillSelect,
      handleValueChange,
      pathPickerItems,
      pathPickerVisible,
      preferredPlacement,
      skillPickerVisible,
    ],
  );
}

export const TextareaCompletionPickers = memo(function TextareaCompletionPickers({
  controller,
}: {
  controller: TextareaCompletionController;
}) {
  return (
    <>
      <SkillPicker
        open={controller.skillPicker.open}
        items={controller.skillPicker.items}
        onSelect={controller.skillPicker.onSelect}
        onEscape={controller.skillPicker.onEscape}
        anchorRef={controller.anchorRef}
        caretLeft={controller.caretLeft}
        preferredPlacement={controller.preferredPlacement}
        commandRef={controller.skillPicker.commandRef}
      />
      <PathPicker
        open={controller.pathPicker.open}
        items={controller.pathPicker.items}
        onSelect={controller.pathPicker.onSelect}
        onEscape={controller.pathPicker.onEscape}
        anchorRef={controller.anchorRef}
        caretLeft={controller.caretLeft}
        preferredPlacement={controller.preferredPlacement}
        commandRef={controller.pathPicker.commandRef}
        fuzzy
      />
    </>
  );
});
