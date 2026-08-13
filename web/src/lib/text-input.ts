type TokenDeleteKeyboardEvent = {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
};

export type TokenDeleteEdit = {
  value: string;
  cursor: number;
};

export function getTokenDeleteEdit(
  event: TokenDeleteKeyboardEvent,
  value: string,
  selectionStart: number,
  selectionEnd: number,
): TokenDeleteEdit | null {
  if (
    !event.ctrlKey ||
    (event.key !== "w" && event.key !== "Backspace") ||
    event.shiftKey ||
    event.altKey ||
    event.metaKey
  ) {
    return null;
  }

  if (selectionStart === 0 && selectionEnd === 0) return { value, cursor: 0 };

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
