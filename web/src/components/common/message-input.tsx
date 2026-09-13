import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { cn } from "cn";
import { ArrowRightIcon, Loader2Icon, OctagonIcon, RotateCcwIcon, XIcon } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/common/button";
import { ShortcutHint } from "@/components/common/kbd";
import { ModelSelector } from "@/components/model-selector";
import { useModifierLabel } from "@/hooks/platform";
import {
  TextareaCompletionPickers,
  useTextareaCompletions,
} from "@/hooks/use-textarea-completions";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";
import type { InternalCommandScope } from "@/lib/internal-commands";
import { useShortcutBindingLabels, useShortcuts } from "@/lib/shortcuts";
import { handleTextInputKeyDown } from "@/lib/text-input";
import type { ImageAttachment, TurnQueueItemSummary } from "@/lib/types";
import {
  getMessageInputButtonShortcutActionId,
  MESSAGE_INPUT_BUTTON_SHORTCUT_KEYS,
} from "../../../../src/shortcuts/catalog.ts";

const draftStore = new Map<string, string>();
const pendingAttachmentStore = new Map<string, ImageAttachment[]>();
const pendingAttachmentListeners = new Map<string, Set<(images: ImageAttachment[]) => void>>();
const MAX_PENDING_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const PENDING_ATTACHMENT_LIMIT_MESSAGE =
  "Pending image limit reached (50 MB). Remove an attachment and try again.";

function attachmentBytes(images: ImageAttachment[]): number {
  return images.reduce((total, image) => total + image.data.length, 0);
}

function storedAttachmentBytes(): number {
  let total = 0;
  for (const images of pendingAttachmentStore.values()) total += attachmentBytes(images);
  return total;
}

function publishStoredAttachments(lane: string, images: ImageAttachment[]): void {
  for (const listener of pendingAttachmentListeners.get(lane) ?? []) listener(images);
}

function appendStoredAttachments(
  lane: string,
  images: ImageAttachment[],
): ImageAttachment[] | null {
  if (storedAttachmentBytes() + attachmentBytes(images) > MAX_PENDING_ATTACHMENT_BYTES) return null;
  const next = [...(pendingAttachmentStore.get(lane) ?? []), ...images];
  pendingAttachmentStore.set(lane, next);
  publishStoredAttachments(lane, next);
  return next;
}

function readImageAttachment(file: File): Promise<ImageAttachment | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = typeof reader.result === "string" ? reader.result.split(",")[1] : undefined;
      resolve(data ? { data, mimeType: file.type } : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

export type MessageInputHoverButton = {
  id: string;
  label: string;
  insertText: string;
};

type HoverSendAction = {
  text: string;
  sourceButtonId: string;
};

type MessageInputHoverButtonSlot = {
  button: MessageInputHoverButton;
  action: "insert" | "send";
  ghost?: boolean;
  reserveButton?: MessageInputHoverButton;
};

const EMPTY_HOVER_BUTTONS: MessageInputHoverButton[] = [];
const EMPTY_HOVER_BUTTON_SLOTS: MessageInputHoverButtonSlot[] = [];

function numericStyleValue(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function horizontalMargin(style: CSSStyleDeclaration) {
  return numericStyleValue(style.marginLeft) + numericStyleValue(style.marginRight);
}

function isBlankDraft(value: string) {
  return value.length === 0 || !/\S/.test(value);
}

const MESSAGE_INPUT_SHORTCUT_ACTIONS = MESSAGE_INPUT_BUTTON_SHORTCUT_KEYS.map((_, index) =>
  getMessageInputButtonShortcutActionId(index + 1),
);

function MessageInputHoverButtons({
  slots,
  disabled,
  composerRef,
  toolbarRef,
  onSlotAction,
}: {
  slots: MessageInputHoverButtonSlot[];
  disabled: boolean;
  composerRef: React.RefObject<HTMLDivElement | null>;
  toolbarRef: React.RefObject<HTMLDivElement | null>;
  onSlotAction: (slot: MessageInputHoverButtonSlot) => void;
}) {
  const buttonRowRef = useRef<HTMLDivElement | null>(null);
  const slotRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const modifierLabel = useModifierLabel();
  const shortcutLabels = useShortcutBindingLabels(MESSAGE_INPUT_SHORTCUT_ACTIONS, {
    compact: true,
    altLabel: modifierLabel,
  });
  const buttonClassName =
    "pointer-events-auto group inline-flex h-10 w-full min-w-0 max-w-full items-center rounded-md border border-border-muted bg-background px-2.5 text-left text-sm text-text-muted transition-colors hover:border-border hover:bg-background-hover hover:text-text focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-inset focus-visible:ring-border-pop sm:h-7";

  useLayoutEffect(() => {
    if (slots.length === 0) return;

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
      const renderedSlots = slotRefs.current.slice(0, slots.length);
      const firstButton = buttonRefs.current[0];
      if (!firstButton) return false;

      const buttonRowRect = buttonRow.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();
      renderedSlots.forEach((slotNode) => {
        if (slotNode) {
          slotNode.hidden = false;
          slotNode.style.width = "";
        }
      });

      const buttonRowStyle = window.getComputedStyle(buttonRow);
      const toolbarStyle = window.getComputedStyle(toolbar);
      const buttonGap = numericStyleValue(buttonRowStyle.columnGap);
      const toolbarGap = numericStyleValue(toolbarStyle.columnGap) || buttonGap;
      const buttonWidths = slots.map(
        (_, index) => buttonRefs.current[index]?.getBoundingClientRect().width ?? 0,
      );
      const availableWidth = Math.max(
        0,
        toolbarRect.left - buttonRowRect.left - horizontalMargin(toolbarStyle) - toolbarGap,
      );

      let usedWidth = 0;
      let visibleCount = 0;
      for (const index of slots.keys()) {
        const nextWidth =
          usedWidth + (visibleCount > 0 ? buttonGap : 0) + Math.ceil(buttonWidths[index] ?? 0);
        if (nextWidth > availableWidth) break;
        usedWidth = nextWidth;
        visibleCount += 1;
      }

      renderedSlots.forEach((slotNode, index) => {
        if (!slotNode) return;
        slotNode.hidden = index >= visibleCount;
        if (index < visibleCount) slotNode.style.width = `${buttonWidths[index]}px`;
      });
      return true;
    };

    function scheduleMeasure() {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const measured = measureAndApply();
        attachObserver();
        if (!measured && retryCount < 10) {
          retryCount += 1;
          scheduleMeasure();
        }
      });
    }

    measureAndApply();
    attachObserver();
    scheduleMeasure();

    return () => {
      observer?.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [slots, composerRef, toolbarRef, shortcutLabels]);

  useShortcuts(
    "composer",
    Object.fromEntries(
      slots.slice(0, MESSAGE_INPUT_SHORTCUT_ACTIONS.length).map((slot, index) => [
        getMessageInputButtonShortcutActionId(index + 1),
        {
          enabled: !disabled && !slot.ghost,
          run: () => onSlotAction(slot),
        },
      ]),
    ),
  );

  if (slots.length === 0) return null;

  const renderButtonContent = (label: string, index: number) => (
    <>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcutLabels[index] && (
        <ShortcutHint
          label={shortcutLabels[index]}
          variant="compact"
          className="ml-2 shrink-0 text-text-muted"
          aria-hidden="true"
        />
      )}
    </>
  );

  return (
    <div
      ref={buttonRowRef}
      className="pointer-events-none absolute left-2.5 bottom-2 flex items-center gap-1.5 overflow-hidden"
    >
      {slots.map((slot, index) => {
        const reserveButton = slot.reserveButton ?? slot.button;
        const isReservedSendSlot = slot.action === "send" && Boolean(slot.reserveButton);
        return (
          <span
            key={reserveButton.id}
            ref={(node) => {
              slotRefs.current[index] = node;
            }}
            className="relative inline-flex max-w-full shrink-0"
          >
            <button
              ref={(node) => {
                buttonRefs.current[index] = node;
              }}
              type="button"
              tabIndex={-1}
              disabled={disabled || slot.ghost || isReservedSendSlot}
              onClick={slot.ghost || isReservedSendSlot ? undefined : () => onSlotAction(slot)}
              className={cn(
                buttonClassName,
                (slot.ghost || isReservedSendSlot) && "invisible pointer-events-none",
              )}
              aria-hidden={slot.ghost || isReservedSendSlot ? "true" : undefined}
              aria-label={
                slot.ghost || isReservedSendSlot ? undefined : `Insert ${slot.button.label}`
              }
              title={
                slot.ghost || isReservedSendSlot ? undefined : `Insert ${slot.button.insertText}`
              }
            >
              {renderButtonContent(reserveButton.label, index)}
            </button>
            {isReservedSendSlot && (
              <button
                type="button"
                tabIndex={-1}
                disabled={disabled}
                onClick={() => onSlotAction(slot)}
                className={cn(buttonClassName, "absolute left-0 top-0")}
                aria-label="Send inserted message"
                title="Send inserted message"
              >
                {renderButtonContent(slot.button.label, index)}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

type MessageInputProps = {
  isSending: boolean;
  disabled?: boolean;
  onSubmit: (text: string, images?: ImageAttachment[]) => Promise<void>;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  streamId?: string;
  fillHeight?: boolean;
  draftKey?: string;
  showModelSelector?: boolean;
  modelSelectorPiSessionId?: string;
  selectedModelId?: string;
  selectedThinkingLevel?: ModelThinkingLevel;
  isSessionBusy?: boolean;
  isCompacting?: boolean;
  onInterrupt?: () => void;
  isInterruptPending?: boolean;
  recoveryKind?: "closed" | "dead";
  onRecover?: () => void;
  hoverButtons?: MessageInputHoverButton[];
  internalCommandScope: InternalCommandScope;
  isRecoverPending?: boolean;
  queuedTurns?: TurnQueueItemSummary[];
  onQueuedTurnsHeightChange?: (height: number) => void;
  onRemoveQueuedTurn?: (itemId: string) => void;
  removingQueuedTurnId?: string;
};

export const MessageInput = memo(function MessageInput({
  isSending,
  disabled = false,
  onSubmit,
  placeholder = "Press i to jump here · / for skills · @ for paths",
  rows = 2,
  autoFocus = false,
  streamId,
  fillHeight = false,
  draftKey,
  showModelSelector = true,
  modelSelectorPiSessionId,
  selectedModelId,
  selectedThinkingLevel,
  isSessionBusy = false,
  isCompacting = false,
  onInterrupt,
  isInterruptPending = false,
  recoveryKind,
  onRecover,
  hoverButtons = EMPTY_HOVER_BUTTONS,
  internalCommandScope,
  isRecoverPending = false,
  queuedTurns = [],
  onQueuedTurnsHeightChange,
  onRemoveQueuedTurn,
  removingQueuedTurnId,
}: MessageInputProps) {
  useWhyDidYouRender("MessageInput", { isSending, placeholder });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const inputOverlayRef = useRef<HTMLDivElement | null>(null);
  const draftKeyRef = useRef(draftKey);
  const mountedRef = useRef(true);
  const [recoveryButtonWidth, setRecoveryButtonWidth] = useState<number | null>(null);
  const [draft, setDraft] = useState(() => (draftKey ? (draftStore.get(draftKey) ?? "") : ""));
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>(() =>
    draftKey ? (pendingAttachmentStore.get(draftKey) ?? []) : [],
  );
  const [isDraftBlank, setIsDraftBlank] = useState(() =>
    isBlankDraft(draftKey ? (draftStore.get(draftKey) ?? "") : ""),
  );
  const [hoverSendAction, setHoverSendAction] = useState<HoverSendAction | null>(null);

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

  useShortcuts("composer", {
    "composer.focus": {
      enabled: () => Boolean(textareaRef.current && !textareaRef.current.disabled),
      run: () => textareaRef.current?.focus(),
    },
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!draftKey) return;
    const listener = (images: ImageAttachment[]) => setPendingImages(images);
    const listeners = pendingAttachmentListeners.get(draftKey) ?? new Set();
    listeners.add(listener);
    pendingAttachmentListeners.set(draftKey, listeners);
    listener(pendingAttachmentStore.get(draftKey) ?? []);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) pendingAttachmentListeners.delete(draftKey);
    };
  }, [draftKey]);

  const draftRef = useRef(draft);
  const onSubmitRef = useRef(onSubmit);
  useEffect(() => {
    draftRef.current = draft;
    onSubmitRef.current = onSubmit;
  });

  const setPendingImagesAndStore = useCallback(
    (update: (current: ImageAttachment[]) => ImageAttachment[]) => {
      const lane = draftKeyRef.current;
      if (!lane) {
        setPendingImages(update);
        return;
      }
      const next = update(pendingAttachmentStore.get(lane) ?? []);
      if (next.length > 0) pendingAttachmentStore.set(lane, next);
      else pendingAttachmentStore.delete(lane);
      publishStoredAttachments(lane, next);
    },
    [],
  );

  const addImageFiles = useCallback((files: FileList | File[]) => {
    const lane = draftKeyRef.current;
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    const batchBytes = imageFiles.reduce((total, file) => total + 4 * Math.ceil(file.size / 3), 0);
    if (lane && storedAttachmentBytes() + batchBytes > MAX_PENDING_ATTACHMENT_BYTES) {
      toast.error(PENDING_ATTACHMENT_LIMIT_MESSAGE);
      return;
    }

    void Promise.all(imageFiles.map(readImageAttachment)).then((results) => {
      const images = results.filter((image): image is ImageAttachment => image !== null);
      if (images.length === 0) return;

      if (!lane) {
        if (mountedRef.current) setPendingImages((current) => [...current, ...images]);
        return;
      }

      const next = appendStoredAttachments(lane, images);
      if (!next) {
        toast.error(PENDING_ATTACHMENT_LIMIT_MESSAGE);
        return;
      }
    });
  }, []);

  const removeImage = useCallback(
    (index: number) => {
      setPendingImagesAndStore((current) => current.filter((_, itemIndex) => itemIndex !== index));
    },
    [setPendingImagesAndStore],
  );

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

  const clearHoverSendAction = useCallback(() => setHoverSendAction(null), []);
  const completionController = useTextareaCompletions({
    textareaRef,
    anchorRef: containerRef,
    valueRef: draftRef,
    setValue: setDraftAndStore,
    internalCommandScope,
    streamId,
    onBeforeValueChange: clearHoverSendAction,
  });

  const handleDraftChange = completionController.handleValueChange;

  const submitCurrentDraft = useCallback(() => {
    if (disabled || isSending || isCompacting || recoveryKind) return;
    const text = draftRef.current.trim();
    if (!text && pendingImages.length === 0) return;
    const submittedImages = pendingImages;
    void onSubmitRef.current(text, submittedImages.length > 0 ? submittedImages : undefined).then(
      () => {
        setPendingImagesAndStore((current) =>
          current === submittedImages
            ? []
            : current.filter((image) => !submittedImages.includes(image)),
        );
      },
      () => undefined,
    );
    setHoverSendAction(null);
    setDraftAndStore("");
  }, [
    disabled,
    isCompacting,
    isSending,
    pendingImages,
    recoveryKind,
    setDraftAndStore,
    setPendingImagesAndStore,
  ]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.key === "Process")
        return;
      if (completionController.handleKeyDown(event)) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        textareaRef.current?.blur();
        return;
      }

      if (
        handleTextInputKeyDown(event, {
          target: textareaRef.current,
          onValueChange: handleDraftChange,
        })
      ) {
        return;
      }

      if (
        event.ctrlKey &&
        event.key === "l" &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        handleDraftChange("");
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        submitCurrentDraft();
      }
    },
    [completionController.handleKeyDown, handleDraftChange, submitCurrentDraft],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled || isCompacting) return;
      const items = event.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length) {
        event.preventDefault();
        addImageFiles(imageFiles);
      }
    },
    [addImageFiles, disabled, isCompacting],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (disabled || isCompacting) return;
      if (event.dataTransfer?.files?.length) {
        addImageFiles(Array.from(event.dataTransfer.files));
      }
    },
    [addImageFiles, disabled, isCompacting],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  }, []);

  const hoverControlsEnabled =
    hoverButtons.length > 0 &&
    pendingImages.length === 0 &&
    !isSending &&
    !disabled &&
    !recoveryKind;
  const hoverSendSourceExists =
    hoverSendAction !== null &&
    hoverButtons.some((button) => button.id === hoverSendAction.sourceButtonId);

  useEffect(() => {
    if (hoverSendAction && !hoverSendSourceExists) setHoverSendAction(null);
  }, [hoverSendAction, hoverSendSourceExists]);

  const shouldShowHoverButtons = hoverButtons.length > 0 && isDraftBlank;
  const shouldShowHoverSendAction =
    hoverControlsEnabled &&
    hoverSendAction !== null &&
    hoverSendSourceExists &&
    draft === hoverSendAction.text;

  const hoverButtonSlots = useMemo<MessageInputHoverButtonSlot[]>(
    () => hoverButtons.map((button) => ({ button, action: "insert" })),
    [hoverButtons],
  );

  const hoverSendSlots = useMemo<MessageInputHoverButtonSlot[]>(() => {
    if (!hoverSendAction || !hoverSendSourceExists) return EMPTY_HOVER_BUTTON_SLOTS;
    return hoverButtons.map((button) =>
      button.id === hoverSendAction.sourceButtonId
        ? {
            button: { id: "hover-send", label: "click to send", insertText: "" },
            action: "send",
            reserveButton: button,
          }
        : { button, action: "insert", ghost: true },
    );
  }, [hoverButtons, hoverSendAction, hoverSendSourceExists]);

  const handleHoverButtonSlotAction = useCallback(
    (slot: MessageInputHoverButtonSlot) => {
      if (slot.ghost) return;
      if (slot.action === "send") {
        if (isSessionBusy || isCompacting) return;
        submitCurrentDraft();
        return;
      }
      const current = draftRef.current;
      const newValue = isBlankDraft(current)
        ? slot.button.insertText
        : `${current}\n${slot.button.insertText}`;
      setHoverSendAction({ text: newValue, sourceButtonId: slot.button.id });
      setDraftAndStore(newValue);
      completionController.dismiss();
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(newValue.length, newValue.length);
      });
    },
    [
      completionController.dismiss,
      isCompacting,
      isSessionBusy,
      setDraftAndStore,
      submitCurrentDraft,
    ],
  );

  const canSend = !disabled && (!isDraftBlank || pendingImages.length > 0);

  useLayoutEffect(() => {
    if (recoveryKind) return;

    const toolbar = toolbarRef.current;
    if (!toolbar) return;

    let frame = 0;
    const measureToolbar = () => {
      if (toolbar.children.length <= 1) return;
      const width = toolbar.getBoundingClientRect().width;
      if (width <= 0) return;
      const roundedWidth = Math.ceil(width);
      setRecoveryButtonWidth((current) => (current === roundedWidth ? current : roundedWidth));
    };
    const scheduleMeasure = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measureToolbar();
      });
    };

    measureToolbar();
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(toolbar);
    window.addEventListener("resize", scheduleMeasure);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [recoveryKind]);

  const recoveryButtonStyle =
    recoveryKind && recoveryButtonWidth !== null ? { width: recoveryButtonWidth } : undefined;

  useLayoutEffect(() => {
    const inputOverlay = inputOverlayRef.current;
    if (!inputOverlay) {
      onQueuedTurnsHeightChange?.(0);
      return;
    }

    const publishHeight = () =>
      onQueuedTurnsHeightChange?.(inputOverlay.getBoundingClientRect().height);
    publishHeight();
    const observer = new ResizeObserver(publishHeight);
    observer.observe(inputOverlay);
    return () => observer.disconnect();
  }, [onQueuedTurnsHeightChange, pendingImages.length, queuedTurns.length]);

  return (
    <div
      className={fillHeight ? "h-full flex flex-col min-h-0" : "shrink-0"}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <div className={cn(fillHeight && "relative flex-1 flex flex-col min-h-0 h-full")}>
        {(pendingImages.length > 0 || queuedTurns.length > 0) && (
          <div
            ref={inputOverlayRef}
            className="absolute inset-x-0 bottom-[calc(100%+2px)] z-10 min-w-0 bg-transparent"
          >
            {pendingImages.length > 0 && (
              <div className="flex w-full min-w-0 flex-wrap items-start gap-2 p-2">
                {pendingImages.map((img, i) => (
                  <div
                    key={`${img.mimeType}:${img.data.length}:${img.data.slice(0, 32)}`}
                    className="relative max-h-24 max-w-[min(24rem,100%)]"
                  >
                    <img
                      src={`data:${img.mimeType};base64,${img.data}`}
                      alt={`Pending attachment ${i + 1}`}
                      className="block h-auto max-h-24 w-auto max-w-full rounded-lg border border-border object-contain"
                    />
                    <button
                      type="button"
                      disabled={isCompacting}
                      onClick={() => removeImage(i)}
                      className="absolute right-1 top-1 flex size-6 touch-manipulation items-center justify-center rounded-full bg-background text-status-crashed shadow-sm transition-colors hover:bg-destructive hover:text-destructive-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-pop disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={`Remove pending attachment ${i + 1}`}
                      title="Remove attachment"
                    >
                      <XIcon className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {queuedTurns.length > 0 && (
              <div
                role="status"
                aria-label="Queued turns"
                aria-live="polite"
                className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-0.75 border-t-2 border-border-muted bg-background px-2 pt-2.25 pb-1.5 text-xs text-text"
              >
                {queuedTurns.map((turn) => {
                  const removalPending = removingQueuedTurnId === turn.id;
                  return (
                    <Fragment key={turn.id}>
                      <div className="max-h-16 min-w-0 overflow-hidden whitespace-pre-wrap break-words">
                        {turn.text}
                      </div>
                      <button
                        type="button"
                        aria-label="Remove queued turn"
                        className="-my-1 flex size-6 shrink-0 touch-manipulation items-center justify-center rounded text-text-muted transition-colors hover:bg-background-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-pop disabled:opacity-40"
                        disabled={
                          turn.state === "accepting" || removalPending || !onRemoveQueuedTurn
                        }
                        onClick={() => onRemoveQueuedTurn?.(turn.id)}
                      >
                        {removalPending ? (
                          <Loader2Icon
                            className="-translate-y-px size-3.5 animate-spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <XIcon className="-translate-y-px size-3.5" aria-hidden="true" />
                        )}
                      </button>
                    </Fragment>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          disabled={disabled}
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) addImageFiles(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
        <div
          ref={containerRef}
          className={cn(
            "relative bg-background before:pointer-events-none before:absolute before:-left-px before:-right-px before:-top-px before:bottom-0 before:z-10 before:border-2 before:border-border-pop before:opacity-0 before:content-[''] focus-within:before:opacity-100",
            fillHeight ? "flex-1 flex flex-col min-h-0" : "h-full",
          )}
        >
          {isCompacting && (
            <span
              role="status"
              aria-live="polite"
              className="absolute right-2 top-2 z-10 text-xs font-medium text-text-muted"
            >
              Compacting…
            </span>
          )}
          <TextareaCompletionPickers controller={completionController} />
          <textarea
            data-shortcut-composer
            ref={textareaRef}
            value={draft}
            disabled={disabled}
            onChange={(e) => handleDraftChange(e.target.value, e.nativeEvent as InputEvent)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={fillHeight ? undefined : rows}
            placeholder={placeholder}
            className={cn(
              "w-full resize-none bg-transparent pl-10 pt-3 text-sm text-text placeholder:text-text-muted focus:outline-none",
              isCompacting ? "pr-28" : "pr-4",
              fillHeight && "flex-1 min-h-0",
            )}
          />
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled || isCompacting}
            onClick={() => fileInputRef.current?.click()}
            className="absolute left-2.5 top-3 rounded p-0.5 text-text-muted transition-colors hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
            title="Attach image"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
            </svg>
          </button>
          {(shouldShowHoverButtons || shouldShowHoverSendAction) && (
            <MessageInputHoverButtons
              slots={shouldShowHoverSendAction ? hoverSendSlots : hoverButtonSlots}
              disabled={
                !hoverControlsEnabled ||
                (shouldShowHoverSendAction && (isSessionBusy || isCompacting))
              }
              composerRef={containerRef}
              toolbarRef={toolbarRef}
              onSlotAction={handleHoverButtonSlotAction}
            />
          )}
          <div ref={toolbarRef} className="absolute right-2 bottom-2 flex items-center gap-1.5">
            {!recoveryKind && showModelSelector && modelSelectorPiSessionId && (
              <ModelSelector
                disabled={disabled || isSending || isCompacting}
                subdued={!shouldShowHoverButtons}
                piSessionId={modelSelectorPiSessionId}
                selectedModelId={selectedModelId}
                selectedThinkingLevel={selectedThinkingLevel}
              />
            )}
            {isCompacting ? (
              <Button
                type="button"
                size="sm"
                disabled
                aria-label="Send unavailable while compacting"
                className="h-10 w-10 sm:h-7 sm:w-auto sm:px-3"
              >
                <ArrowRightIcon className="size-4" />
              </Button>
            ) : recoveryKind ? (
              <Button
                type="button"
                variant="subtle"
                size="sm"
                disabled={isRecoverPending || !onRecover}
                onClick={() => onRecover?.()}
                className="h-10 shrink-0 px-3 sm:h-7"
                style={recoveryButtonStyle}
              >
                <RotateCcwIcon className="size-4" />
                <span className="text-base">
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
                variant="danger"
                size="sm"
                disabled={disabled || isInterruptPending || !onInterrupt}
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
                disabled={disabled || isSending || !canSend}
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
