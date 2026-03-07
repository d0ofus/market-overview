import type { MarketSession } from "./alerts-types";

type NyDateParts = {
  weekday: string;
  isoDate: string;
  minutesOfDay: number;
};

const nyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function addDays(isoDate: string, days: number): string {
  const value = new Date(`${isoDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function isWeekdayShort(value: string): boolean {
  return value === "Mon" || value === "Tue" || value === "Wed" || value === "Thu" || value === "Fri";
}

function nextWeekday(isoDate: string): string {
  let cursor = addDays(isoDate, 1);
  for (let i = 0; i < 8; i += 1) {
    const day = new Date(`${cursor}T00:00:00Z`).getUTCDay();
    if (day >= 1 && day <= 5) return cursor;
    cursor = addDays(cursor, 1);
  }
  return isoDate;
}

function previousWeekday(isoDate: string): string {
  let cursor = addDays(isoDate, -1);
  for (let i = 0; i < 8; i += 1) {
    const day = new Date(`${cursor}T00:00:00Z`).getUTCDay();
    if (day >= 1 && day <= 5) return cursor;
    cursor = addDays(cursor, -1);
  }
  return isoDate;
}

function toNyParts(input: Date): NyDateParts {
  const parts = nyFormatter.formatToParts(input);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const year = Number(get("year") || "1970");
  const month = Number(get("month") || "1");
  const day = Number(get("day") || "1");
  const hour = Number(get("hour") || "0");
  const minute = Number(get("minute") || "0");
  return {
    weekday: get("weekday"),
    isoDate: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    minutesOfDay: hour * 60 + minute,
  };
}

export function classifyUsMarketSession(input: Date): MarketSession {
  const ny = toNyParts(input);
  if (isWeekdayShort(ny.weekday) && ny.minutesOfDay >= 570 && ny.minutesOfDay < 960) return "regular";
  if (isWeekdayShort(ny.weekday) && ny.minutesOfDay >= 240 && ny.minutesOfDay < 570) return "premarket";
  return "after-hours";
}

export function tradingDayForAlert(input: Date): string {
  const ny = toNyParts(input);
  if (!isWeekdayShort(ny.weekday)) {
    return nextWeekday(ny.isoDate);
  }
  if (ny.minutesOfDay >= 960) {
    return nextWeekday(ny.isoDate);
  }
  if (ny.minutesOfDay < 240) {
    return previousWeekday(ny.isoDate);
  }
  return ny.isoDate;
}

export function parseIsoOrNow(raw: string | null | undefined): Date {
  if (!raw) return new Date();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return new Date();
  return parsed;
}

export function classifyAlertTimestamp(raw: string | null | undefined): {
  receivedAtUtc: string;
  marketSession: MarketSession;
  tradingDay: string;
} {
  const at = parseIsoOrNow(raw);
  return {
    receivedAtUtc: at.toISOString(),
    marketSession: classifyUsMarketSession(at),
    tradingDay: tradingDayForAlert(at),
  };
}

export function todayNyIso(): string {
  return toNyParts(new Date()).isoDate;
}

export function subtractDaysIso(isoDate: string, days: number): string {
  return addDays(isoDate, -days);
}

