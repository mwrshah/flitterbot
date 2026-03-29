/**
 * Format the current date/time as a block suitable for appending to system prompts
 * or user messages. Uses the same format as maybeInjectDatetime() in runtime.ts.
 */
export function formatDatetimeBlock(): string {
  const datetimeStr = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Karachi",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });

  return (
    `<date_time>\nJust so you know, the current date and time is: ${datetimeStr}. ` +
    `This is injected programmatically, for information only — you may disregard if not relevant.\n</date_time>`
  );
}
