import { layoutWithLines, prepareWithSegments } from "@chenglou/pretext";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { ArrowRightIcon, Loader2Icon, OctagonIcon, RotateCcwIcon } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "~/components/common/button";
import { ShortcutHint } from "~/components/common/kbd";
import { ModelSelector } from "~/components/model-selector";
import { PathPicker } from "~/components/path-picker";
import { SkillPicker } from "~/components/skill-picker";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import {
  getMessageInputButtonShortcutActionId,
  MESSAGE_INPUT_BUTTON_SHORTCUT_KEYS,
  registerComposerFocusTarget,
  registerShortcutHandlers,
} from "~/lib/global-shortcuts";
import { getInternalCommandsForScope, type InternalCommandScope } from "~/lib/internal-commands";
import { directoryCompletionsQueryOptions, skillsQueryOptions } from "~/lib/queries";
import type {
  DirectoryCompletionItem,
  ImageAttachment,
  SkillListItem,
  ThinkingLevel,
} from "~/lib/types";
import { cn } from "~/lib/utils";

/** Module-level store: persists draft text per route across navigations. */
const draftStore = new Map<string, string>();

export type MessageInputHoverButton = {
  id: string;
  label: string;
  insertText: string;
};

const EMPTY_HOVER_BUTTONS: MessageInputHoverButton[] = [];
const EMPTY_PATH_ITEMS: DirectoryCompletionItem[] = [];
const HOVER_BUTTON_MEASURE_WIDTH_PX = 10_000;
/** Sub-pixel safety margin so a button that "just fits" in pretext pixels
 *  doesn't get clipped by browser rounding or fractional widths. */

function pretextTextWidth(text: string, font: string, lineHeight: number) {
  const prepared = prepareWithSegments(text, font, { whiteSpace: "pre-wrap" });
  const result = layoutWithLines(prepared, HOVER_BUTTON_MEASURE_WIDTH_PX, lineHeight);
  return result.lines[0]?.width ?? 0;
}

function numericStyleValue(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function horizontalMargin(style: CSSStyleDeclaration) {
  return numericStyleValue(style.marginLeft) + numericStyleValue(style.marginRight);
}

function horizontalBox(style: CSSStyleDeclaration) {
  return (
    numericStyleValue(style.paddingLeft) +
    numericStyleValue(style.paddingRight) +
    numericStyleValue(style.borderLeftWidth) +
    numericStyleValue(style.borderRightWidth) +
    horizontalMargin(style)
  );
}

function isBlankDraft(value: string) {
  return value.length === 0 || !/\S/.test(value);
}

function autoExpandedDuplicateSlashIndex(filter: string) {
  if (filter.startsWith("~//")) return 2;
  if (filter.startsWith("..//")) return 3;

  const nestedDotDot = "/..//";
  const nestedIndex = filter.lastIndexOf(nestedDotDot);
  return nestedIndex >= 0 ? nestedIndex + nestedDotDot.length - 1 : -1;
}

function filterSkillsForPicker(skills: SkillListItem[], filter: string) {
  const lower = filter.toLowerCase();
  const matched = filter ? skills.filter((s) => s.name.toLowerCase().includes(lower)) : skills;
  // Pin command-kind items to the bottom, preserving relative order within each group.
  const nonCommands: SkillListItem[] = [];
  const commands: SkillListItem[] = [];
  for (const item of matched) {
    (item.kind === "command" ? commands : nonCommands).push(item);
  }
  return [...nonCommands, ...commands];
}

function messageInputButtonShortcutLabel(index: number) {
  return MESSAGE_INPUT_BUTTON_SHORTCUT_KEYS[index] ?? null;
}

function MessageInputHoverButtons({
  buttons,
  composerRef,
  toolbarRef,
  onInsert,
}: {
  buttons: MessageInputHoverButton[];
  composerRef: React.RefObject<HTMLDivElement | null>;
  toolbarRef: React.RefObject<HTMLDivElement | null>;
  onInsert: (button: MessageInputHoverButton, visibleBlockWidth: number) => void;
}) {
  const buttonRowRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const visibleBlockWidthRef = useRef(0);

  useLayoutEffect(() => {
    if (buttons.length === 0) return;

    let frame = 0;
    let observer: ResizeObserver | null = null;
    let retryCount = 0;

    const getElements = () => {
      const composer = composerRef.current;
      const toolbar = toolbarRef.current;
      const buttonRow = buttonRowRef.current;
      if (!composer || !toolbar || !buttonRow) return null;
      return { composer, toolbar, buttonRow };
    };

    const attachObserver = () => {
      if (observer) return true;
      const elements = getElements();
      if (!elements) return false;
      observer = new ResizeObserver(scheduleMeasure);
      observer.observe(elements.composer);
      observer.observe(elements.toolbar);
      return true;
    };

    const measureAndApply = () => {
      const elements = getElements();
      if (!elements) return false;

      const { toolbar, buttonRow } = elements;
      const renderedButtons = buttonRefs.current.slice(0, buttons.length);
      const firstButton = renderedButtons[0];
      if (!firstButton) return false;

      const buttonRowRect = buttonRow.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();
      const buttonStyle = window.getComputedStyle(firstButton);
      const shortcutStyle = firstButton.lastElementChild
        ? window.getComputedStyle(firstButton.lastElementChild)
        : null;
      const buttonRowStyle = window.getComputedStyle(buttonRow);
      const toolbarStyle = window.getComputedStyle(toolbar);
      const lineHeight = numericStyleValue(buttonStyle.lineHeight) || 16;
      const font = `${buttonStyle.fontWeight} ${buttonStyle.fontSize} ${buttonStyle.fontFamily}`;
      const buttonChrome = horizontalBox(buttonStyle);
      const shortcutMargin = shortcutStyle ? horizontalMargin(shortcutStyle) : 0;
      const buttonGap = numericStyleValue(buttonRowStyle.columnGap);
      const toolbarGap = numericStyleValue(toolbarStyle.columnGap) || buttonGap;
      const availableWidth = Math.max(
        0,
        toolbarRect.left - buttonRowRect.left - horizontalMargin(toolbarStyle) - toolbarGap,
      );

      let usedWidth = 0;
      let visibleCount = 0;
      for (const [index, button] of buttons.entries()) {
        const shortcutLabel = messageInputButtonShortcutLabel(index);
        const shortcutWidth = shortcutLabel
          ? pretextTextWidth(shortcutLabel, font, lineHeight) + shortcutMargin
          : 0;
        const textWidth = pretextTextWidth(button.label, font, lineHeight) + shortcutWidth;
        const nextWidth =
          usedWidth + (visibleCount > 0 ? buttonGap : 0) + Math.ceil(textWidth + buttonChrome);
        if (nextWidth > availableWidth) break;
        usedWidth = nextWidth;
        visibleCount += 1;
      }

      visibleBlockWidthRef.current = usedWidth;
      renderedButtons.forEach((button, index) => {
        if (button) button.hidden = index >= visibleCount;
      });
      return true;
    };

    function scheduleMeasure() {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        // pretext returns CSS pixels; everything here is measured in CSS pixels.
        const measured = measureAndApply();
        attachObserver();
        if (!measured && retryCount < 10) {
          retryCount += 1;
          scheduleMeasure();
        }
      });
    }

    // Measure synchronously before first paint so hidden buttons never flash over
    // the model selector. The rAF pass catches late ref/font/layout settlement.
    measureAndApply();
    attachObserver();
    scheduleMeasure();

    return () => {
      observer?.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [buttons, composerRef, toolbarRef]);

  const currentVisibleBlockWidth = () => {
    const buttonRow = buttonRowRef.current;
    if (!buttonRow) return visibleBlockWidthRef.current;

    const buttonGap = numericStyleValue(window.getComputedStyle(buttonRow).columnGap);
    let width = 0;
    let visibleCount = 0;
    for (const button of buttonRefs.current.slice(0, buttons.length)) {
      if (!button || button.hidden) continue;
      width += button.getBoundingClientRect().width + (visibleCount > 0 ? buttonGap : 0);
      visibleCount += 1;
    }
    return width || visibleBlockWidthRef.current;
  };

  useEffect(() => {
    const handlers = buttons
      .slice(0, MESSAGE_INPUT_BUTTON_SHORTCUT_KEYS.length)
      .map((button, index) => ({
        actionId: getMessageInputButtonShortcutActionId(index + 1),
        priority: 10,
        handler: () => {
          const node = buttonRefs.current[index];
          if (!node || node.hidden || node.disabled) return false;
          onInsert(button, currentVisibleBlockWidth());
          return true;
        },
      }));
    const cleanup = registerShortcutHandlers(handlers);
    return cleanup;
  }, [buttons, onInsert]);

  if (buttons.length === 0) return null;

  return (
    <div
      ref={buttonRowRef}
      className="pointer-events-none absolute left-2.5 bottom-2 flex items-center gap-1.5 overflow-hidden"
    >
      {buttons.map((button, index) => (
        <button
          key={button.id}
          ref={(node) => {
            buttonRefs.current[index] = node;
          }}
          type="button"
          onClick={() => onInsert(button, currentVisibleBlockWidth())}
          className="pointer-events-auto inline-flex h-10 sm:h-7 max-w-full shrink-0 items-center rounded-md border border-border/70 bg-background/90 px-2.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-inset focus-visible:ring-ring"
          aria-label={`Insert ${button.label}`}
          title={`Insert ${button.insertText}`}
        >
          <span className="truncate">{button.label}</span>
          {messageInputButtonShortcutLabel(index) && (
            <ShortcutHint
              label={messageInputButtonShortcutLabel(index)!}
              className="ml-2 shrink-0 text-sidebar-foreground/30"
              kbdSize="compact"
              kbdTone="sidebar"
              aria-hidden="true"
            />
          )}
        </button>
      ))}
    </div>
  );
}

type MessageInputProps = {
  isSending: boolean;
  /** Submit handler — selected model is set server-side via the inline selector. */
  onSubmit: (text: string) => void;
  pendingImages: ImageAttachment[];
  onAddImages: (files: FileList | File[]) => void;
  onRemoveImage: (index: number) => void;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  /** Stream ID — when set, enables fuzzy file search within the stream's repo. */
  streamId?: string;
  fillHeight?: boolean;
  /** Key into draftStore — when set, persists draft text across route navigations. */
  draftKey?: string;
  /** Show the model-selector popover-trigger left of the send button. Default: true. */
  showModelSelector?: boolean;
  modelSelectorMode?: "default" | "pi-session";
  modelSelectorPiSessionId?: string;
  selectedModelId?: string;
  selectedThinkingLevel?: ThinkingLevel;
  /** Agent is generating — send button swaps to a stop-sign icon. */
  isSessionBusy?: boolean;
  /** Disable image attach/paste/drop without changing the session action button. */
  attachmentsDisabled?: boolean;
  /** Triggered when the user clicks the stop-sign while session is busy. */
  onInterrupt?: () => void;
  /** Interrupt request in flight — disables the stop button. */
  isInterruptPending?: boolean;
  /** When set, send button is replaced with a Reopen/Recover action.
   *  - 'closed' → stream itself was closed; label is "Reopen"
   *  - 'dead'   → stream is open but its pi-session ended/crashed; label is "Recover" */
  recoveryKind?: "closed" | "dead";
  /** Triggered when the user clicks the recovery action. */
  onRecover?: () => void;
  /** Optional plain-text snippet buttons shown inside an empty composer. */
  hoverButtons?: MessageInputHoverButton[];
  /** Composer context controls which contextual built-in slash commands are offered. */
  internalCommandScope: InternalCommandScope;
  /** Recovery request in flight — disables the recovery button. */
  isRecoverPending?: boolean;
};

const rootRouteApi = getRouteApi("__root__");

export const MessageInput = memo(function MessageInput({
  isSending,
  onSubmit,
  pendingImages,
  onAddImages,
  onRemoveImage,
  placeholder = "Press i to jump here · / for skills · @ for paths",
  rows = 2,
  autoFocus = false,
  streamId,
  fillHeight = false,
  draftKey,
  showModelSelector = true,
  modelSelectorMode = "default",
  modelSelectorPiSessionId,
  selectedModelId,
  selectedThinkingLevel,
  isSessionBusy = false,
  attachmentsDisabled = false,
  onInterrupt,
  isInterruptPending = false,
  recoveryKind,
  onRecover,
  hoverButtons = EMPTY_HOVER_BUTTONS,
  internalCommandScope,
  isRecoverPending = false,
}: MessageInputProps) {
  useWhyDidYouRender("MessageInput", { isSending, pendingImages, placeholder });
  // Skills list (base built-in commands + server skills) comes pre-merged from
  // skillsQueryOptions and is prefetched in the root loader, so this read is
  // synchronous on first render after app boot. Contextual built-ins are scoped
  // here so each composer exposes only commands valid for its surface.
  const { apiClient } = rootRouteApi.useRouteContext();
  const { data: baseSkills } = useQuery(skillsQueryOptions(apiClient));
  const skills = useMemo(() => {
    const contextualCommands = getInternalCommandsForScope(internalCommandScope).filter(
      (command) => !(baseSkills ?? []).some((skill) => skill.name === command.name),
    );
    return [...(baseSkills ?? []), ...contextualCommands];
  }, [baseSkills, internalCommandScope]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const draftKeyRef = useRef(draftKey);
  const [draft, setDraft] = useState(() => (draftKey ? (draftStore.get(draftKey) ?? "") : ""));
  const [isDraftBlank, setIsDraftBlank] = useState(() =>
    isBlankDraft(draftKey ? (draftStore.get(draftKey) ?? "") : ""),
  );
  const imagesDisabled = isSessionBusy || attachmentsDisabled;
  const [hoverSendAction, setHoverSendAction] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState("");
  const [caretLeft, setCaretLeft] = useState(0);
  // Track the position of the "/" that triggered the picker
  const slashPositionRef = useRef<number>(-1);
  const skillCommandRef = useRef<HTMLDivElement>(null);

  // @ path picker state (parallel to slash picker)
  const [atPickerOpen, setAtPickerOpen] = useState(false);
  const [atPickerFilter, setAtPickerFilter] = useState("");
  const pathCommandRef = useRef<HTMLDivElement>(null);
  const atPositionRef = useRef<number>(-1);
  const tildeExpandedRef = useRef(false);
  // One-shot: tracks whether we've already auto-appended "/" after a trailing
  // bare `..` segment. Resets when the trailing segment is no longer `..`,
  // so chained `..` `..` `..` keystrokes produce `../../../`.
  const dotDotExpandedRef = useRef(false);

  // Auto-focus textarea on mount when requested, cursor to end of any hydrated draft
  useEffect(() => {
    if (autoFocus) {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.focus();
        const len = textarea.value.length;
        if (len > 0) textarea.setSelectionRange(len, len);
      }
    }
  }, [autoFocus]);

  useEffect(() => {
    registerComposerFocusTarget(() => textareaRef.current?.focus());
    return () => registerComposerFocusTarget(null);
  }, []);

  // Debounce the path filter before querying
  const [debouncedAtFilter, setDebouncedAtFilter] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedAtFilter(atPickerFilter), 150);
    return () => clearTimeout(id);
  }, [atPickerFilter]);

  // Query directory completions for the @-picker. `keepPreviousData` in the
  // query options preserves the last list across refetches, so typing doesn't
  // flicker to empty. Cache is keyed per (query, streamId).
  const { data: pathResult } = useQuery(
    directoryCompletionsQueryOptions(debouncedAtFilter, atPickerOpen, { streamId }),
  );
  const filteredSkills = useMemo(
    () => filterSkillsForPicker(skills, pickerFilter),
    [skills, pickerFilter],
  );
  const pathPickerItems = pathResult?.items ?? EMPTY_PATH_ITEMS;
  const skillPickerVisible = pickerOpen && filteredSkills.length > 0;
  const pathPickerVisible = atPickerOpen && pathPickerItems.length > 0;

  // Warm the cache for the empty query on mount so the first `@` has items
  // ready without a loading flash. Re-runs when streamId changes.
  const queryClient = useQueryClient();
  useEffect(() => {
    queryClient.prefetchQuery(directoryCompletionsQueryOptions("", true, { streamId }));
  }, [queryClient, streamId]);

  // Refs for stable useCallback closures
  const draftRef = useRef(draft);
  const onSubmitRef = useRef(onSubmit);
  const onAddImagesRef = useRef(onAddImages);
  useEffect(() => {
    draftRef.current = draft;
    onSubmitRef.current = onSubmit;
    onAddImagesRef.current = onAddImages;
  });

  const setDraftAndStore = useCallback((value: string) => {
    const nextIsDraftBlank = isBlankDraft(value);

    if (draftKeyRef.current) {
      if (value) draftStore.set(draftKeyRef.current, value);
      else draftStore.delete(draftKeyRef.current);
    }
    draftRef.current = value;
    setDraft(value);
    setIsDraftBlank((current) => (current === nextIsDraftBlank ? current : nextIsDraftBlank));
  }, []);

  /** Close a picker on Escape: remove trigger text, reset position ref, refocus. */
  const closePicker = useCallback(
    (triggerPos: number, setOpen: (v: boolean) => void, posRef: React.MutableRefObject<number>) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      setOpen(false);
      const value = draftRef.current;
      const cursor = textarea.selectionStart ?? value.length;
      const newValue = value.slice(0, triggerPos) + value.slice(cursor);
      setDraftAndStore(newValue);
      posRef.current = -1;
      requestAnimationFrame(() => {
        textarea.setSelectionRange(triggerPos, triggerPos);
        textarea.focus();
      });
    },
    [setDraftAndStore],
  );

  /**
   * Compute the pixel X position of a character index in the textarea,
   * relative to the container div, using pretext's prepare + layout.
   */
  const computeSlashLeft = useCallback((value: string, slashIdx: number) => {
    const textarea = textareaRef.current;
    const container = containerRef.current;
    if (!textarea || !container || slashIdx < 0) return;

    const style = window.getComputedStyle(textarea);
    const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const paddingLeft = parseFloat(style.paddingLeft);
    const paddingRight = parseFloat(style.paddingRight);
    const contentWidth = textarea.offsetWidth - paddingLeft - paddingRight;
    const lineHeight = parseFloat(style.lineHeight);

    const textBeforeTrigger = value.slice(0, slashIdx);
    const prepared = prepareWithSegments(textBeforeTrigger, font, { whiteSpace: "pre-wrap" });
    const result = layoutWithLines(prepared, contentWidth, lineHeight);

    const lastLine = result.lines[result.lines.length - 1];
    const xOffset = lastLine ? lastLine.width : 0;

    const popoverWidth = 320; // w-80
    const maxLeft = container.offsetWidth - popoverWidth;
    setCaretLeft(Math.min(Math.max(0, paddingLeft + xOffset), maxLeft));
  }, []);

  /**
   * Detect a slash command token at the cursor position.
   * A slash trigger is "/" preceded by start-of-string or whitespace,
   * followed by zero or more non-whitespace chars up to the cursor.
   */
  const handleDraftChange = useCallback(
    (rawValue: string, inputEvent?: InputEvent) => {
      setHoverSendAction(null);
      let value = rawValue;
      const cursor = textareaRef.current?.selectionStart ?? value.length;

      // Only the literal `/` keystroke gets this normalization. Backspace,
      // paste, programmatic edits, and later typing within `/command| text`
      // must not keep re-inserting spaces just because a slash is nearby.
      const typedSlash = inputEvent?.inputType === "insertText" && inputEvent.data === "/";
      const slashBeforeCursor = cursor - 1;
      const typedSlashBeforeText =
        typedSlash &&
        value.charAt(slashBeforeCursor) === "/" &&
        /\S/.test(value.charAt(cursor)) &&
        (slashBeforeCursor === 0 || /\s/.test(value.charAt(slashBeforeCursor - 1)));
      if (typedSlashBeforeText) {
        value = `${value.slice(0, cursor)} ${value.slice(cursor)}`;
        requestAnimationFrame(() => {
          textareaRef.current?.setSelectionRange(cursor, cursor);
        });
      }
      setDraftAndStore(value);

      // Scan backwards from cursor to find a "/" trigger
      let slashIdx = -1;
      for (let i = cursor - 1; i >= 0; i--) {
        const ch = value[i];
        if (ch === "/") {
          if (i === 0 || /\s/.test(value[i - 1]!)) {
            slashIdx = i;
          }
          break;
        }
        if (/\s/.test(ch!)) break;
      }

      // Scan backwards from cursor to find an "@" trigger
      // Unlike "/" scan, we do NOT stop at "/" characters (paths contain slashes)
      let atIdx = -1;
      for (let i = cursor - 1; i >= 0; i--) {
        const ch = value[i];
        if (ch === "@") {
          if (i === 0 || /\s/.test(value[i - 1]!)) {
            atIdx = i;
          }
          break;
        }
        if (/\s/.test(ch!)) break;
      }

      // Only one picker at a time: @ takes priority when both could match
      if (atIdx >= 0) {
        const filter = value.slice(atIdx + 1, cursor);

        // Auto-append "/" when user types @~ so the picker queries home dir contents
        // One-shot: skip if we already expanded ~ to ~/ this session
        if (filter === "~" && !tildeExpandedRef.current) {
          tildeExpandedRef.current = true;
          const newValue = `${value.slice(0, cursor)}/${value.slice(cursor)}`;
          const newCursor = cursor + 1;
          setDraftAndStore(newValue);
          atPositionRef.current = atIdx;
          computeSlashLeft(newValue, atIdx);
          setAtPickerOpen(true);
          setAtPickerFilter("~/");
          slashPositionRef.current = -1;
          setPickerOpen(false);
          requestAnimationFrame(() => {
            textareaRef.current?.setSelectionRange(newCursor, newCursor);
          });
          return;
        }

        // Reset one-shot tilde flag when filter no longer starts with ~
        if (!filter.startsWith("~")) {
          tildeExpandedRef.current = false;
        }

        // Auto-append "/" when the trailing segment of the filter is a bare `..`,
        // so the picker drills into the parent directory. One-shot per segment:
        // resets below when the trailing segment is no longer `..`, which lets
        // chained `..` keystrokes produce `../../../`.
        const trailingDotDot = filter === ".." || filter.endsWith("/..");
        if (trailingDotDot && !dotDotExpandedRef.current) {
          dotDotExpandedRef.current = true;
          const newValue = `${value.slice(0, cursor)}/${value.slice(cursor)}`;
          const newCursor = cursor + 1;
          setDraftAndStore(newValue);
          atPositionRef.current = atIdx;
          computeSlashLeft(newValue, atIdx);
          setAtPickerOpen(true);
          setAtPickerFilter(`${filter}/`);
          slashPositionRef.current = -1;
          setPickerOpen(false);
          requestAnimationFrame(() => {
            textareaRef.current?.setSelectionRange(newCursor, newCursor);
          });
          return;
        }
        if (!trailingDotDot) {
          dotDotExpandedRef.current = false;
        }

        // Collapse the user's own "/" keystroke when it doubles an auto-inserted slash.
        const extraSlash = autoExpandedDuplicateSlashIndex(filter);
        if (extraSlash >= 0) {
          const extra = atIdx + 1 + extraSlash;
          const newValue = value.slice(0, extra) + value.slice(extra + 1);
          const newCursor = cursor - 1;
          setDraftAndStore(newValue);
          atPositionRef.current = atIdx;
          computeSlashLeft(newValue, atIdx);
          setAtPickerOpen(true);
          setAtPickerFilter(filter.slice(0, extraSlash) + filter.slice(extraSlash + 1));
          slashPositionRef.current = -1;
          setPickerOpen(false);
          requestAnimationFrame(() => {
            textareaRef.current?.setSelectionRange(newCursor, newCursor);
          });
          return;
        }

        atPositionRef.current = atIdx;
        computeSlashLeft(value, atIdx);
        setAtPickerOpen(true);
        setAtPickerFilter(filter);
        // Close slash picker
        slashPositionRef.current = -1;
        setPickerOpen(false);
      } else if (slashIdx >= 0 && skills?.length) {
        const filter = value.slice(slashIdx + 1, cursor);
        slashPositionRef.current = slashIdx;
        computeSlashLeft(value, slashIdx);
        setPickerOpen(true);
        setPickerFilter(filter);
        // Close @ picker
        atPositionRef.current = -1;
        setAtPickerOpen(false);
      } else {
        slashPositionRef.current = -1;
        setPickerOpen(false);
        atPositionRef.current = -1;
        setAtPickerOpen(false);
        tildeExpandedRef.current = false;
        dotDotExpandedRef.current = false;
      }
    },
    [skills, computeSlashLeft, setDraftAndStore],
  );

  const handleSkillSelect = useCallback(
    (skill: SkillListItem) => {
      const value = draftRef.current;
      const slashIdx = slashPositionRef.current;
      // Find end of the trigger token (non-whitespace run from trigger position)
      let tokenEnd = slashIdx + 1;
      while (tokenEnd < value.length && !/\s/.test(value[tokenEnd]!)) tokenEnd++;
      // Regular skills need "/skill:<name> " so the pi-sdk's `_expandSkillCommand`
      // guard fires and inlines SKILL.md at send time. Built-in commands are not
      // skills; keep them as literal slash commands (e.g. "/clear", "/reload").
      const before = value.slice(0, slashIdx);
      const after = value.slice(tokenEnd);
      const inserted = skill.kind === "command" ? `/${skill.name} ` : `/skill:${skill.name} `;
      const newValue = before + inserted + after;
      setDraftAndStore(newValue);
      setPickerOpen(false);
      slashPositionRef.current = -1;
      // Restore cursor position after the inserted command
      const newCursor = before.length + inserted.length;
      requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(newCursor, newCursor);
        textareaRef.current?.focus();
      });
    },
    [setDraftAndStore],
  );

  const handlePathSelect = useCallback(
    (item: DirectoryCompletionItem) => {
      const value = draftRef.current;
      const atIdx = atPositionRef.current;
      // Find end of the trigger token (non-whitespace run from trigger position)
      let tokenEnd = atIdx + 1;
      while (tokenEnd < value.length && !/\s/.test(value[tokenEnd]!)) tokenEnd++;
      const before = value.slice(0, atIdx);
      const after = value.slice(tokenEnd);
      // Directories: insert @path/ (no trailing space, keeps picker open for drill-down)
      // Files: insert @path (trailing space, closes picker)
      const isDir = item.kind === "directory";
      const inserted = `@${item.insertText}${isDir ? "" : " "}`;
      const newValue = before + inserted + after;
      setDraftAndStore(newValue);
      if (!isDir) {
        setAtPickerOpen(false);
        atPositionRef.current = -1;
      }
      const newCursor = before.length + inserted.length;
      requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(newCursor, newCursor);
        textareaRef.current?.focus();
        // For directories, re-trigger the change handler so the picker refetches
        if (isDir) {
          handleDraftChange(newValue);
        }
      });
    },
    [handleDraftChange, setDraftAndStore],
  );

  const submitCurrentDraft = useCallback(() => {
    if (isSending || recoveryKind || (imagesDisabled && pendingImages.length > 0)) return;
    const text = draftRef.current.trim();
    if (!text && pendingImages.length === 0) return;
    onSubmitRef.current(text);
    setHoverSendAction(null);
    setDraftAndStore("");
  }, [imagesDisabled, isSending, pendingImages.length, recoveryKind, setDraftAndStore]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        if (skillPickerVisible && slashPositionRef.current >= 0) {
          event.preventDefault();
          closePicker(slashPositionRef.current, setPickerOpen, slashPositionRef);
        } else if (pathPickerVisible && atPositionRef.current >= 0) {
          event.preventDefault();
          closePicker(atPositionRef.current, setAtPickerOpen, atPositionRef);
        } else {
          // No picker open — defocus the input
          textareaRef.current?.blur();
        }
        return;
      }

      // Ctrl+W / Ctrl+Backspace: backward-kill-word
      if (
        event.ctrlKey &&
        (event.key === "w" || event.key === "Backspace") &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        const value = draftRef.current;
        const cursor = textareaRef.current?.selectionStart ?? value.length;
        if (cursor === 0) return;
        let i = cursor;
        const isDelim = (ch: string) => ch === "/" || ch === "@";
        // Skip whitespace before cursor
        const beforeWS = i;
        while (i > 0 && /\s/.test(value[i - 1]!)) i--;
        const skippedWhitespace = i < beforeWS;
        if (i > 0 && isDelim(value[i - 1]!)) {
          if (skippedWhitespace) {
            // Whitespace separated cursor from delimiter — eat delimiter(s) but stop before the word
            while (i > 0 && isDelim(value[i - 1]!)) i--;
          } else {
            // Cursor was right next to delimiter — eat it and the word before it
            while (i > 0 && isDelim(value[i - 1]!)) i--;
            while (i > 0 && !/\s/.test(value[i - 1]!) && !isDelim(value[i - 1]!)) i--;
          }
        } else {
          // Skip word characters, stopping at whitespace or delimiters
          while (i > 0 && !/\s/.test(value[i - 1]!) && !isDelim(value[i - 1]!)) i--;
        }
        const newValue = value.slice(0, i) + value.slice(cursor);
        handleDraftChange(newValue);
        requestAnimationFrame(() => {
          textareaRef.current?.setSelectionRange(i, i);
        });
        return;
      }

      // Ctrl+L: clear input (terminal-style)
      if (
        event.ctrlKey &&
        event.key === "l" &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        handleDraftChange("");
        return;
      }

      // When a visible picker is open, forward navigation keys to cmdk.
      // Tab is mapped to Enter so it accepts the highlighted item.
      // Keep empty-result pickers closed so they don't intercept composer keys.
      const navKeys = ["ArrowDown", "ArrowUp", "Enter", "Tab", "Home", "End"];
      if (skillPickerVisible && slashPositionRef.current >= 0 && navKeys.includes(event.key)) {
        event.preventDefault();
        skillCommandRef.current?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: event.key === "Tab" ? "Enter" : event.key,
            bubbles: true,
          }),
        );
        return;
      }
      if (pathPickerVisible && atPositionRef.current >= 0 && navKeys.includes(event.key)) {
        event.preventDefault();
        pathCommandRef.current?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: event.key === "Tab" ? "Enter" : event.key,
            bubbles: true,
          }),
        );
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitCurrentDraft();
      }
    },
    [closePicker, handleDraftChange, pathPickerVisible, skillPickerVisible, submitCurrentDraft],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          if (imagesDisabled) {
            event.preventDefault();
            return;
          }
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length) {
        event.preventDefault();
        onAddImagesRef.current(imageFiles);
      }
    },
    [imagesDisabled],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (imagesDisabled) return;
      if (event.dataTransfer?.files?.length) {
        onAddImagesRef.current(Array.from(event.dataTransfer.files));
      }
    },
    [imagesDisabled],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  }, []);

  const hoverControlsEnabled =
    hoverButtons.length > 0 &&
    pendingImages.length === 0 &&
    !isSending &&
    !isSessionBusy &&
    !recoveryKind;
  const shouldShowHoverButtons = hoverControlsEnabled && isDraftBlank;
  const shouldShowHoverSendAction =
    hoverControlsEnabled && hoverSendAction !== null && draft === hoverSendAction;

  const handleHoverButtonClick = useCallback(
    (button: MessageInputHoverButton, _visibleBlockWidth: number) => {
      if (button.insertText === "") {
        submitCurrentDraft();
        return;
      }
      const current = draftRef.current;
      const newValue = isBlankDraft(current)
        ? button.insertText
        : `${current}\n${button.insertText}`;
      setHoverSendAction(newValue);
      setDraftAndStore(newValue);
      setPickerOpen(false);
      setAtPickerOpen(false);
      slashPositionRef.current = -1;
      atPositionRef.current = -1;
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(newValue.length, newValue.length);
      });
    },
    [setDraftAndStore, submitCurrentDraft],
  );

  const canSend =
    (!isDraftBlank || pendingImages.length > 0) && !(imagesDisabled && pendingImages.length > 0);

  return (
    <div
      className={cn(
        "border-t border-border",
        fillHeight ? "h-full flex flex-col min-h-0" : "shrink-0",
      )}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <div className={cn(fillHeight && "flex-1 flex flex-col min-h-0 h-full")}>
        {pendingImages.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {pendingImages.map((img, i) => (
              <div
                key={`${img.mimeType}:${img.data.length}:${img.data.slice(0, 32)}`}
                className="relative group"
              >
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt="Pending attachment"
                  className="size-16 object-cover rounded-lg border border-border"
                />
                <button
                  type="button"
                  onClick={() => onRemoveImage(i)}
                  className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-destructive text-destructive-foreground text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          disabled={imagesDisabled}
          className="hidden"
          onChange={(e) => {
            if (!imagesDisabled && e.target.files?.length) onAddImages(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
        <div
          ref={containerRef}
          className={cn(
            "relative bg-background focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring",
            fillHeight ? "flex-1 flex flex-col min-h-0" : "h-full",
          )}
        >
          <SkillPicker
            open={skillPickerVisible}
            items={filteredSkills}
            onSelect={handleSkillSelect}
            caretLeft={caretLeft}
            commandRef={skillCommandRef}
            anchorRef={containerRef}
          />
          <PathPicker
            open={pathPickerVisible}
            items={pathPickerItems}
            onSelect={handlePathSelect}
            caretLeft={caretLeft}
            commandRef={pathCommandRef}
            anchorRef={containerRef}
            fuzzy
          />
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => handleDraftChange(e.target.value, e.nativeEvent as InputEvent)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={fillHeight ? undefined : rows}
            placeholder={placeholder}
            className={cn(
              "w-full bg-transparent pl-10 pr-4 pt-3 text-sm text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none",
              fillHeight && "flex-1 min-h-0",
            )}
          />
          {/* Attach button — top left */}
          <button
            type="button"
            tabIndex={-1}
            disabled={imagesDisabled}
            onClick={() => fileInputRef.current?.click()}
            className="absolute left-2.5 top-3.5 text-muted-foreground/60 hover:text-foreground transition-colors rounded p-0.5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground/60"
            title={
              imagesDisabled ? "Images can't be queued while the session is busy" : "Attach image"
            }
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
            </svg>
          </button>
          {/* Hover buttons fit against the whole right toolbar, including model selector and send/recovery. */}
          {(shouldShowHoverButtons || shouldShowHoverSendAction) && (
            <MessageInputHoverButtons
              buttons={
                shouldShowHoverSendAction
                  ? [{ id: "hover-send", label: "click to send", insertText: "" }]
                  : hoverButtons
              }
              composerRef={containerRef}
              toolbarRef={toolbarRef}
              onInsert={handleHoverButtonClick}
            />
          )}
          <div ref={toolbarRef} className="absolute right-2 bottom-2 flex items-center gap-1.5">
            {showModelSelector && (
              <ModelSelector
                disabled={isSending}
                mode={modelSelectorMode}
                piSessionId={modelSelectorPiSessionId}
                selectedModelId={selectedModelId}
                selectedThinkingLevel={selectedThinkingLevel}
              />
            )}
            {recoveryKind ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isRecoverPending || !onRecover}
                onClick={() => onRecover?.()}
                className="h-10 sm:h-7 px-3"
              >
                <RotateCcwIcon className="size-4" />
                <span>
                  {isRecoverPending
                    ? recoveryKind === "dead"
                      ? "Recovering…"
                      : "Reopening…"
                    : recoveryKind === "dead"
                      ? "Recover"
                      : "Reopen"}
                </span>
              </Button>
            ) : isSessionBusy ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={isInterruptPending || !onInterrupt}
                onClick={() => onInterrupt?.()}
                className="h-10 w-10 sm:h-7 sm:w-auto sm:px-3"
                title="Stop"
              >
                <OctagonIcon className="size-4 fill-current" />
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={isSending || !canSend}
                onClick={submitCurrentDraft}
                className="h-10 w-10 sm:h-7 sm:w-auto sm:px-3"
              >
                {isSending ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <ArrowRightIcon className="size-4" />
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
