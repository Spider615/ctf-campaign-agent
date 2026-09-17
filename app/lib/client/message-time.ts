const TIME_ZONE = "Asia/Shanghai";

function validDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function partsOf(date: Date, includeSeconds = false) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" as const } : {}),
    hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return {
    year: Number(part("year")),
    month: Number(part("month")),
    day: Number(part("day")),
    hour: part("hour"),
    minute: part("minute"),
    second: includeSeconds ? part("second") : "",
  };
}

export function formatMessageTime(iso: string, now: Date = new Date()): string {
  const date = validDate(iso);
  if (!date) return "时间未知";
  const message = partsOf(date);
  const referenceDate = validDate(now);
  const reference = referenceDate ? partsOf(referenceDate) : null;
  const time = `${message.hour}:${message.minute}`;
  if (reference && message.year === reference.year && message.month === reference.month && message.day === reference.day) {
    return time;
  }
  return `${message.month}月${message.day}日 ${time}`;
}

export function messageTimeTitle(iso: string): string {
  const date = validDate(iso);
  if (!date) return "时间未知";
  const value = partsOf(date, true);
  return `${value.year}年${value.month}月${value.day}日 ${value.hour}:${value.minute}:${value.second}`;
}
