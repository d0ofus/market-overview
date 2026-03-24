import type { Env } from "./types";

const CME_FEDWATCH_URL = "https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html";
const FEDWATCH_USER_AGENT = "market-command-centre/1.0";
const SNAPSHOT_RETENTION_DAYS = 14;

export type FedWatchProbability = {
  targetRange: string;
  targetRateBpsLow: number;
  targetRateBpsHigh: number;
  midpointBps: number;
  nowPct: number;
  dayAgoPct: number | null;
  weekAgoPct: number | null;
  monthAgoPct: number | null;
};

export type FedWatchMeeting = {
  meetingDate: string | null;
  label: string;
  contract: string | null;
  expires: string | null;
  midPrice: number | null;
  priorVolume: number | null;
  priorOi: number | null;
  expectedMidpointBps: number | null;
  hikeProbability: number | null;
  cutProbability: number | null;
  noChangeProbability: number | null;
  probabilities: FedWatchProbability[];
};

export type FedWatchData = {
  generatedAt: string;
  sourceUrl: string;
  currentTargetRange: string | null;
  meetings: FedWatchMeeting[];
};

export type FedWatchResponse = {
  status: "ok" | "stale" | "unavailable";
  warning: string | null;
  data: FedWatchData | null;
};

type StoredFedWatchSnapshotRow = {
  id: string;
  generatedAt: string;
  sourceUrl: string;
  currentTargetRange: string | null;
  dataJson: string;
};

type ParsedMeetingMeta = {
  meetingDate: string | null;
  label: string;
  contract: string | null;
  expires: string | null;
  midPrice: number | null;
  priorVolume: number | null;
  priorOi: number | null;
};

function stripHtmlTags(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"');
}

function parsePercent(value: string): number | null {
  const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNumber(value: string): number | null {
  const cleaned = value.replace(/,/g, "").trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTargetRange(value: string): { label: string; low: number; high: number } | null {
  const normalized = decodeHtml(stripHtmlTags(value)).replace(/\(Current\)/gi, "").trim();
  const match = normalized.match(/(\d{2,4})\s*-\s*(\d{2,4})/);
  if (!match) return null;
  const low = Number(match[1]);
  const high = Number(match[2]);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return { label: `${low}-${high}`, low, high };
}

function midpointBps(low: number, high: number): number {
  return (low + high) / 2;
}

function parseDateLabelToIso(value: string): string | null {
  const cleaned = value.replace(/\s+/g, " ").trim();
  const match = cleaned.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
    .indexOf(match[2].toLowerCase());
  const year = Number(match[3]);
  if (month < 0 || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

function parseTableRows(html: string): string[][] {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  return rows
    .map((match) => [...match[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => decodeHtml(stripHtmlTags(cell[1]))))
    .filter((cells) => cells.length > 0);
}

function parseMeetingMeta(tableHtml: string): ParsedMeetingMeta | null {
  const rows = parseTableRows(tableHtml);
  if (rows.length < 2) return null;
  const headers = rows[0].map((cell) => cell.toLowerCase());
  const values = rows[1];
  const read = (name: string) => {
    const idx = headers.findIndex((header) => header.includes(name));
    return idx >= 0 ? values[idx] ?? null : null;
  };
  const label = read("meeting date") ?? read("meeting");
  if (!label) return null;
  return {
    meetingDate: parseDateLabelToIso(label),
    label,
    contract: read("contract"),
    expires: read("expires"),
    midPrice: parseNumber(read("mid price") ?? ""),
    priorVolume: parseNumber(read("prior volume") ?? ""),
    priorOi: parseNumber(read("prior oi") ?? ""),
  };
}

function parseProbabilityTable(tableHtml: string): FedWatchProbability[] {
  const rows = parseTableRows(tableHtml);
  if (rows.length < 2) return [];
  const headers = rows[0].map((cell) => cell.toLowerCase());
  const targetIdx = headers.findIndex((header) => header.includes("target rate"));
  const nowIdx = headers.findIndex((header) => header.includes("now"));
  const dayIdx = headers.findIndex((header) => header.includes("1 day"));
  const weekIdx = headers.findIndex((header) => header.includes("1 week"));
  const monthIdx = headers.findIndex((header) => header.includes("1 month"));
  if (targetIdx < 0 || nowIdx < 0) return [];

  return rows
    .slice(1)
    .map((cells) => {
      const range = parseTargetRange(cells[targetIdx] ?? "");
      const nowPct = parsePercent(cells[nowIdx] ?? "");
      if (!range || nowPct == null) return null;
      return {
        targetRange: range.label,
        targetRateBpsLow: range.low,
        targetRateBpsHigh: range.high,
        midpointBps: midpointBps(range.low, range.high),
        nowPct,
        dayAgoPct: dayIdx >= 0 ? parsePercent(cells[dayIdx] ?? "") : null,
        weekAgoPct: weekIdx >= 0 ? parsePercent(cells[weekIdx] ?? "") : null,
        monthAgoPct: monthIdx >= 0 ? parsePercent(cells[monthIdx] ?? "") : null,
      } satisfies FedWatchProbability;
    })
    .filter((value): value is FedWatchProbability => Boolean(value))
    .sort((left, right) => left.targetRateBpsLow - right.targetRateBpsLow);
}

function computeExpectedMidpoint(probabilities: FedWatchProbability[]): number | null {
  const weightedSum = probabilities.reduce((sum, row) => sum + (row.midpointBps * row.nowPct), 0);
  const totalPct = probabilities.reduce((sum, row) => sum + row.nowPct, 0);
  if (!Number.isFinite(weightedSum) || totalPct <= 0) return null;
  return weightedSum / totalPct;
}

function summarizeBias(probabilities: FedWatchProbability[], currentTargetRange: string | null): Pick<FedWatchMeeting, "hikeProbability" | "cutProbability" | "noChangeProbability"> {
  const current = currentTargetRange ? parseTargetRange(currentTargetRange) : null;
  if (!current) {
    return { hikeProbability: null, cutProbability: null, noChangeProbability: null };
  }
  let hikeProbability = 0;
  let cutProbability = 0;
  let noChangeProbability = 0;
  for (const row of probabilities) {
    if (row.targetRateBpsLow > current.low) {
      hikeProbability += row.nowPct;
    } else if (row.targetRateBpsLow < current.low) {
      cutProbability += row.nowPct;
    } else {
      noChangeProbability += row.nowPct;
    }
  }
  return { hikeProbability, cutProbability, noChangeProbability };
}

export function parseFedWatchIframeSrc(publicHtml: string): string | null {
  const match = publicHtml.match(/<iframe[^>]+src="([^"]*IntegratedFedWatchTool[^"]*)"/i);
  if (!match?.[1]) return null;
  return decodeHtml(match[1]);
}

export function parseFedWatchRedirectLocation(rawHeaders: string): string | null {
  const match = rawHeaders.match(/^location:\s*(.+)$/im);
  return match?.[1]?.trim() ?? null;
}

export function parseFedWatchToolHtml(html: string, generatedAt = new Date().toISOString(), sourceUrl = CME_FEDWATCH_URL): FedWatchData | null {
  const currentTargetRange = html.match(/Current target rate is\s+(\d{2,4}\s*-\s*\d{2,4})/i)?.[1]?.replace(/\s+/g, "");
  const meetingBlocks = [...html.matchAll(/(<table[\s\S]*?MEETING DATE[\s\S]*?<\/table>)[\s\S]*?(<table[\s\S]*?TARGET RATE[\s\S]*?<\/table>)/gi)];
  const parsedMeetings: FedWatchMeeting[] = meetingBlocks
    .map((block) => {
      const meta = parseMeetingMeta(block[1]);
      const probabilities = parseProbabilityTable(block[2]);
      if (!meta || probabilities.length === 0) return null;
      return {
        ...meta,
        expectedMidpointBps: computeExpectedMidpoint(probabilities),
        ...summarizeBias(probabilities, currentTargetRange ?? null),
        probabilities,
      } satisfies FedWatchMeeting;
    })
    .filter((value): value is FedWatchMeeting => Boolean(value));

  if (parsedMeetings.length === 0) return null;
  return {
    generatedAt,
    sourceUrl,
    currentTargetRange: currentTargetRange ?? null,
    meetings: parsedMeetings,
  };
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`FedWatch request failed (${response.status}) for ${url}`);
  }
  return await response.text();
}

async function fetchLiveFedWatchData(): Promise<FedWatchData> {
  const publicHtml = await fetchText(CME_FEDWATCH_URL, {
    headers: {
      "User-Agent": FEDWATCH_USER_AGENT,
    },
  });
  const iframeSrc = parseFedWatchIframeSrc(publicHtml);
  if (!iframeSrc) {
    throw new Error("Unable to locate the embedded CME FedWatch tool URL on the public page.");
  }

  const initialResponse = await fetch(iframeSrc, {
    headers: {
      "Referer": CME_FEDWATCH_URL,
      "User-Agent": FEDWATCH_USER_AGENT,
    },
    redirect: "manual",
  });
  const sessionLocation = initialResponse.headers.get("location");
  const sessionUrl = sessionLocation
    ? new URL(sessionLocation, iframeSrc).toString()
    : iframeSrc;
  const toolHtml = await fetchText(sessionUrl, {
    headers: {
      "Referer": CME_FEDWATCH_URL,
      "User-Agent": FEDWATCH_USER_AGENT,
    },
  });

  const parsed = parseFedWatchToolHtml(toolHtml, new Date().toISOString(), CME_FEDWATCH_URL);
  if (!parsed) {
    throw new Error("CME FedWatch loaded, but the tool did not expose parseable meeting probabilities in server-rendered HTML.");
  }
  return parsed;
}

function parseStoredData(raw: string): FedWatchData | null {
  try {
    const parsed = JSON.parse(raw) as FedWatchData | null;
    return parsed?.meetings?.length ? parsed : null;
  } catch {
    return null;
  }
}

async function loadLatestStoredSnapshot(env: Env): Promise<FedWatchData | null> {
  const row = await env.DB.prepare(
    "SELECT id, generated_at as generatedAt, source_url as sourceUrl, current_target_range as currentTargetRange, data_json as dataJson FROM fedwatch_snapshots ORDER BY datetime(generated_at) DESC LIMIT 1",
  ).first<StoredFedWatchSnapshotRow>();
  if (!row?.dataJson) return null;
  const parsed = parseStoredData(row.dataJson);
  if (!parsed) return null;
  return {
    ...parsed,
    generatedAt: row.generatedAt ?? parsed.generatedAt,
    sourceUrl: row.sourceUrl ?? parsed.sourceUrl,
    currentTargetRange: row.currentTargetRange ?? parsed.currentTargetRange ?? null,
  };
}

function isSnapshotCurrentForToday(generatedAt: string, now = new Date()): boolean {
  return generatedAt.slice(0, 10) === now.toISOString().slice(0, 10);
}

async function persistSnapshot(env: Env, data: FedWatchData): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO fedwatch_snapshots (id, generated_at, source_url, current_target_range, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(
    crypto.randomUUID(),
    data.generatedAt,
    data.sourceUrl,
    data.currentTargetRange,
    JSON.stringify(data),
    data.generatedAt,
  ).run();
}

async function cleanupOldSnapshots(env: Env, retentionDays = SNAPSHOT_RETENTION_DAYS): Promise<void> {
  await env.DB.prepare("DELETE FROM fedwatch_snapshots WHERE datetime(generated_at) < datetime('now', ?)")
    .bind(`-${Math.max(1, retentionDays)} day`)
    .run();
}

export async function getFedWatchSnapshot(env: Env, options?: { force?: boolean }): Promise<FedWatchResponse> {
  const cached = await loadLatestStoredSnapshot(env);
  if (!options?.force && cached && isSnapshotCurrentForToday(cached.generatedAt)) {
    return { status: "ok", warning: null, data: cached };
  }

  try {
    const live = await fetchLiveFedWatchData();
    await persistSnapshot(env, live);
    await cleanupOldSnapshots(env, SNAPSHOT_RETENTION_DAYS);
    return { status: "ok", warning: null, data: live };
  } catch (error) {
    const message = error instanceof Error ? error.message : "FedWatch fetch failed.";
    if (cached) {
      return {
        status: "stale",
        warning: `Showing the last successful FedWatch snapshot because the live CME website could not be parsed today. ${message}`,
        data: cached,
      };
    }
    return {
      status: "unavailable",
      warning: `FedWatch data is temporarily unavailable from the public CME website. ${message}`,
      data: null,
    };
  }
}

export async function refreshFedWatchSnapshot(env: Env): Promise<FedWatchResponse> {
  return await getFedWatchSnapshot(env, { force: true });
}
