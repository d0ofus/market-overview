export function parseLocalTime(value: string | null | undefined): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? "").trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function zonedParts(now: Date, timezone: string): { weekday: string; day: number; minutesOfDay: number; localDate: string } {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const year = Number(get("year") || "1970");
  const month = Number(get("month") || "1");
  const day = Number(get("day") || "1");
  const hour = Number(get("hour") || "0");
  const minute = Number(get("minute") || "0");
  const weekday = get("weekday");
  return {
    weekday,
    day,
    minutesOfDay: hour * 60 + minute,
    localDate: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

export function previousWeekdayIso(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

export function latestUsSessionAsOfDate(now: Date): string {
  const ny = zonedParts(now, "America/New_York");
  const hour = Math.floor(ny.minutesOfDay / 60);
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(ny.weekday);
  if (!isWeekday) {
    return previousWeekdayIso(ny.localDate);
  }
  return hour >= 16 ? ny.localDate : previousWeekdayIso(ny.localDate);
}

export function shouldRunScheduledEod(now: Date, timezone: string, refreshTime: string | null | undefined): boolean {
  const target = parseLocalTime(refreshTime) ?? { hour: 8, minute: 15 };
  const local = zonedParts(now, timezone);
  const targetMinutes = target.hour * 60 + target.minute;
  return local.minutesOfDay >= targetMinutes && local.minutesOfDay < targetMinutes + 15;
}
