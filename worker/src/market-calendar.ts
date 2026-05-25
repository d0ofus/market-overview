import { previousWeekdayIso, zonedParts } from "./refresh-timing";

export type UsMarketSessionKind = "pre_market" | "regular" | "after_hours" | "closed";

export type UsMarketSessionContext = {
  nowIso: string;
  nyDate: string;
  nyTime: string;
  sessionDate: string;
  latestCompletedSessionDate: string;
  status: UsMarketSessionKind;
  label: string;
  dataBasis: "intraday" | "closing" | "pre_market" | "closed_market";
  isTradingDay: boolean;
  closedReason: string | null;
};

const MARKET_OPEN_MINUTES = 9 * 60 + 30;
const MARKET_CLOSE_MINUTES = 16 * 60;

function isoDateFromUtcParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): string {
  const date = new Date(Date.UTC(year, month - 1, 1));
  const firstDay = date.getUTCDay();
  const offset = (weekday - firstDay + 7) % 7;
  date.setUTCDate(1 + offset + (nth - 1) * 7);
  return date.toISOString().slice(0, 10);
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): string {
  const date = new Date(Date.UTC(year, month, 0));
  const lastDay = date.getUTCDay();
  const offset = (lastDay - weekday + 7) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function observedFixedHoliday(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  if (weekday === 6) {
    date.setUTCDate(date.getUTCDate() - 1);
    return date.getUTCFullYear() === year ? date.toISOString().slice(0, 10) : null;
  }
  if (weekday === 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    return date.getUTCFullYear() === year ? date.toISOString().slice(0, 10) : null;
  }
  return date.toISOString().slice(0, 10);
}

function easterSundayIso(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return isoDateFromUtcParts(year, month, day);
}

function addDaysIso(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function usMarketHolidayName(isoDate: string): string | null {
  const year = Number(isoDate.slice(0, 4));
  const holidays = new Map<string, string>();
  const fixed = [
    [1, 1, "New Year's Day"],
    [6, 19, "Juneteenth National Independence Day"],
    [7, 4, "Independence Day"],
    [12, 25, "Christmas Day"],
  ] as const;

  for (const [month, day, name] of fixed) {
    const observed = observedFixedHoliday(year, month, day);
    if (observed) holidays.set(observed, name);
  }

  holidays.set(nthWeekdayOfMonth(year, 1, 1, 3), "Martin Luther King Jr. Day");
  holidays.set(nthWeekdayOfMonth(year, 2, 1, 3), "Washington's Birthday");
  holidays.set(addDaysIso(easterSundayIso(year), -2), "Good Friday");
  holidays.set(lastWeekdayOfMonth(year, 5, 1), "Memorial Day");
  holidays.set(nthWeekdayOfMonth(year, 9, 1, 1), "Labor Day");
  holidays.set(nthWeekdayOfMonth(year, 11, 4, 4), "Thanksgiving Day");

  return holidays.get(isoDate) ?? null;
}

export function isUsMarketTradingDay(isoDate: string): boolean {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  if (day === 0 || day === 6) return false;
  return !usMarketHolidayName(isoDate);
}

export function previousUsMarketTradingDay(isoDate: string): string {
  let cursor = previousWeekdayIso(isoDate);
  while (!isUsMarketTradingDay(cursor)) {
    cursor = previousWeekdayIso(cursor);
  }
  return cursor;
}

export function getUsMarketSessionContext(now = new Date()): UsMarketSessionContext {
  const ny = zonedParts(now, "America/New_York");
  const hour = Math.floor(ny.minutesOfDay / 60);
  const minute = ny.minutesOfDay % 60;
  const nyTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const holidayName = usMarketHolidayName(ny.localDate);
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(ny.weekday);
  const isTradingDay = weekday && !holidayName;

  if (!isTradingDay) {
    const closedReason = holidayName ? `US cash equity market closed for ${holidayName}` : "US cash equity market closed for weekend";
    const latestCompletedSessionDate = previousUsMarketTradingDay(ny.localDate);
    return {
      nowIso: now.toISOString(),
      nyDate: ny.localDate,
      nyTime,
      sessionDate: latestCompletedSessionDate,
      latestCompletedSessionDate,
      status: "closed",
      label: `${closedReason}; using ${latestCompletedSessionDate} closing data`,
      dataBasis: "closed_market",
      isTradingDay: false,
      closedReason,
    };
  }

  if (ny.minutesOfDay < MARKET_OPEN_MINUTES) {
    const latestCompletedSessionDate = previousUsMarketTradingDay(ny.localDate);
    return {
      nowIso: now.toISOString(),
      nyDate: ny.localDate,
      nyTime,
      sessionDate: ny.localDate,
      latestCompletedSessionDate,
      status: "pre_market",
      label: `Pre-market as of ${nyTime} ET; using ${latestCompletedSessionDate} closing data plus fresh sources where available`,
      dataBasis: "pre_market",
      isTradingDay: true,
      closedReason: null,
    };
  }

  if (ny.minutesOfDay < MARKET_CLOSE_MINUTES) {
    return {
      nowIso: now.toISOString(),
      nyDate: ny.localDate,
      nyTime,
      sessionDate: ny.localDate,
      latestCompletedSessionDate: previousUsMarketTradingDay(ny.localDate),
      status: "regular",
      label: `Intraday regular session as of ${nyTime} ET`,
      dataBasis: "intraday",
      isTradingDay: true,
      closedReason: null,
    };
  }

  return {
    nowIso: now.toISOString(),
    nyDate: ny.localDate,
    nyTime,
    sessionDate: ny.localDate,
    latestCompletedSessionDate: ny.localDate,
    status: "after_hours",
    label: `After-hours/post-close as of ${nyTime} ET; using ${ny.localDate} closing data where available`,
    dataBasis: "closing",
    isTradingDay: true,
    closedReason: null,
  };
}
