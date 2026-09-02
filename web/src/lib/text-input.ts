export type TokenDeleteKeyboardEvent = {
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
  defaultPrevented?: boolean;
};

export type TokenDeleteEdit = {
  value: string;
  cursor: number;
};

export type HandleTextInputKeyDownOptions = {
  target?: HTMLInputElement | HTMLTextAreaElement | null;
  onValueChange?: (nextValue: string) => void;
  minCursor?: number;
};

const VALID_INPUT_TYPES = new Set(["text", "search", "password", "email", "url", "tel", ""]);

export function isTokenDeleteShortcut(event: TokenDeleteKeyboardEvent): boolean {
  if (event.defaultPrevented) return false;
  if (!event.ctrlKey) return false;
  if (event.shiftKey || event.altKey || event.metaKey) return false;
  if (event.isComposing || event.nativeEvent?.isComposing) return false;
  const key = event.key;
  if (key === "w" || key === "W" || key === "Backspace") return true;
  if (event.code === "KeyW") return true;
  return false;
}

export function isEditableTextInput(
  element: unknown,
): element is HTMLInputElement | HTMLTextAreaElement {
  if (typeof window === "undefined" || !(element instanceof HTMLElement)) return false;
  if (element instanceof HTMLTextAreaElement) {
    return !element.disabled && !element.readOnly;
  }
  if (element instanceof HTMLInputElement) {
    if (element.disabled || element.readOnly) return false;
    const type = element.getAttribute("type")?.toLowerCase() ?? "text";
    return VALID_INPUT_TYPES.has(type);
  }
  return false;
}

export function getTokenDeleteEdit(
  event: TokenDeleteKeyboardEvent,
  value: string,
  selectionStart: number,
  selectionEnd: number,
): TokenDeleteEdit | null {
  if (!isTokenDeleteShortcut(event)) {
    return null;
  }

  if (selectionStart !== selectionEnd) {
    const start = Math.max(0, Math.min(selectionStart, selectionEnd));
    const end = Math.max(0, Math.max(selectionStart, selectionEnd));
    return {
      value: value.slice(0, start) + value.slice(end),
      cursor: start,
    };
  }

  if (selectionStart <= 0) return { value, cursor: 0 };

  let cursor = selectionStart;
  const isDelimiter = (character: string) => character === "/" || character === "@";
  const beforeWhitespace = cursor;
  while (cursor > 0 && /\s/.test(value[cursor - 1]!)) cursor--;
  const skippedWhitespace = cursor < beforeWhitespace;

  if (cursor > 0 && isDelimiter(value[cursor - 1]!)) {
    if (skippedWhitespace) {
      while (cursor > 0 && isDelimiter(value[cursor - 1]!)) cursor--;
    } else {
      while (cursor > 0 && isDelimiter(value[cursor - 1]!)) cursor--;
      while (cursor > 0 && !/\s/.test(value[cursor - 1]!) && !isDelimiter(value[cursor - 1]!)) {
        cursor--;
      }
    }
  } else {
    while (cursor > 0 && !/\s/.test(value[cursor - 1]!) && !isDelimiter(value[cursor - 1]!)) {
      cursor--;
    }
  }

  return {
    value: value.slice(0, cursor) + value.slice(selectionEnd),
    cursor,
  };
}

export function setNativeInputValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  if (typeof window === "undefined") return;
  const prototype =
    element instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  const setter = descriptor?.set;
  if (setter) {
    setter.call(element, value);
  } else {
    element.value = value;
  }
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

export function handleTextInputKeyDown(
  event: TokenDeleteKeyboardEvent & {
    target?: EventTarget | null;
    currentTarget?: EventTarget | null;
    preventDefault?: () => void;
    stopPropagation?: () => void;
  },
  options?: HandleTextInputKeyDownOptions,
): boolean {
  if (!isTokenDeleteShortcut(event)) return false;

  const target =
    options?.target ??
    (event.target instanceof HTMLElement
      ? event.target
      : event.currentTarget instanceof HTMLElement
        ? event.currentTarget
        : null);

  if (!isEditableTextInput(target)) return false;

  const value = target.value;
  const selectionStart = target.selectionStart ?? value.length;
  const selectionEnd = target.selectionEnd ?? selectionStart;

  const edit = getTokenDeleteEdit(event, value, selectionStart, selectionEnd);
  if (!edit) return false;

  event.preventDefault?.();
  event.stopPropagation?.();

  const cursor =
    options?.minCursor !== undefined ? Math.max(options.minCursor, edit.cursor) : edit.cursor;

  if (options?.onValueChange) {
    options.onValueChange(edit.value);
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(() => {
        try {
          target.setSelectionRange(cursor, cursor);
        } catch {}
      });
    }
  } else {
    setNativeInputValue(target, edit.value);
    try {
      target.setSelectionRange(cursor, cursor);
    } catch {}
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(() => {
        try {
          target.setSelectionRange(cursor, cursor);
        } catch {}
      });
    }
  }

  return true;
}
