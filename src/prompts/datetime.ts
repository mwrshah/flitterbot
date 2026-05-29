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

  return `[Now: ${datetimeStr}]`;
}
