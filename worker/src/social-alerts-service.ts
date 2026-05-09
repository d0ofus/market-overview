import { z } from "zod";
import type { Env } from "./types";
import { parseLocalTime, zonedParts } from "./refresh-timing";

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CASHTAG_TOKEN_RE = /^[A-Z]{1,6}(?:[.\-][A-Z]{1,3})?$/;
const CASHTAG_RE = /(^|[^A-Za-z0-9_])\$([A-Za-z]{1,6}(?:[.\-][A-Za-z]{1,3})?)(?![A-Za-z0-9_])/g;
const DEFAULT_LIMIT_PER_HANDLE = 50;
const MAX_LIMIT_PER_HANDLE = 500;
const MAX_HANDLES_PER_RUN = 10;
const DEFAULT_SERVICE_TIMEOUT_MS = 55_000;
const CREDENTIAL_KEY = "scweet_auth_token";
const DEFAULT_LOG_RETENTION_DAYS = 10;
const DEFAULT_SETTINGS_ID = "default";
const DEFAULT_DAILY_SCRAPE_TIME_LOCAL = "10:00";
const DEFAULT_DAILY_SCRAPE_TIMEZONE = "Australia/Melbourne";
const DEFAULT_DAILY_SCRAPE_LOOKBACK_DAYS = 1;
const MAX_LOG_QUERY_ROWS = 5_000;

export type SocialAlertHealthStatus =
  | "missing_token"
  | "configured"
  | "working"
  | "expired"
  | "rate_limited"
  | "function_unreachable"
  | "missing_config"
  | "error";

export type SocialAlertSourceRow = {
  id: string;
  handle: string;
  displayName: string | null;
  isActive: boolean;
  lastScrapedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SocialAlertMetrics = {
  tweets: number;
  cashtagHits: number;
  uniqueTickers: number;
  failures: number;
  runtimeMs: number;
};

export type SocialAlertResultRow = {
  id: string;
  handle: string;
  tweetId: string | null;
  tweetCreatedAt: string | null;
  cashtags: string[];
  text: string;
  url: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type SocialAlertBlacklistedCashtagRow = {
  ticker: string;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SocialAlertSettings = {
  id: string;
  dailyScrapeEnabled: boolean;
  dailyScrapeTimeLocal: string;
  dailyScrapeTimezone: string;
  dailyScrapeLookbackDays: number;
  updatedAt: string;
};

export type SocialAlertMention = {
  postId: string;
  handle: string;
  tweetId: string | null;
  tweetCreatedAt: string | null;
  text: string;
  url: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type SocialAlertTickerSummary = {
  ticker: string;
  mentionCount: number;
  latestMention: SocialAlertMention;
  mentions: SocialAlertMention[];
};

type StoredCredentialRow = {
  ciphertextBase64: string;
  ivBase64: string;
  keyVersion: number;
  tokenLast4: string | null;
  status: string;
  lastValidatedAt: string | null;
  updatedAt: string;
};

type ScweetPost = {
  handle?: string | null;
  tweetId?: string | null;
  createdAt?: string | null;
  text?: string | null;
  url?: string | null;
  raw?: unknown;
};

type ScweetFailure = {
  handle?: string | null;
  error?: string | null;
  status?: string | null;
};

type ScweetServiceResponse = {
  ok?: boolean;
  status?: SocialAlertHealthStatus | string;
  message?: string | null;
  posts?: ScweetPost[];
  failures?: ScweetFailure[];
  runtimeMs?: number;
  scweetVersion?: string | null;
};

const handleCreateSchema = z.object({
  handle: z.string().trim().min(1).max(120),
});

const credentialSchema = z.object({
  authToken: z.string().trim().min(8).max(4096),
  validate: z.boolean().optional().default(true),
});

const scrapeSchema = z.object({
  allHandles: z.boolean().optional().default(false),
  handleIds: z.array(z.string().trim().min(1)).max(MAX_HANDLES_PER_RUN).optional().default([]),
  startDate: z.string().regex(DATE_RE),
  limitPerHandle: z.number().int().min(1).max(MAX_LIMIT_PER_HANDLE).optional().default(DEFAULT_LIMIT_PER_HANDLE),
});

const blacklistCreateSchema = z.object({
  ticker: z.string().trim().min(1).max(16).transform((value) => normalizeCashtagTicker(value)),
  reason: z.string().trim().max(240).nullable().optional(),
});

const settingsPatchSchema = z.object({
  dailyScrapeEnabled: z.boolean(),
  dailyScrapeTimeLocal: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  dailyScrapeTimezone: z.string().trim().min(1).max(80),
  dailyScrapeLookbackDays: z.number().int().min(1).max(DEFAULT_LOG_RETENTION_DAYS),
});

export function validateSocialAlertScrapePayload(body: unknown): z.infer<typeof scrapeSchema> {
  return scrapeSchema.parse(body);
}

function nowIso(): string {
  return new Date().toISOString();
}

function addDaysIso(isoDate: string, days: number): string {
  const value = new Date(`${isoDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function defaultLogEndDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function normalizeCashtagTicker(raw: string): string {
  const ticker = String(raw ?? "").trim().replace(/^\$+/, "").toUpperCase();
  if (!CASHTAG_TOKEN_RE.test(ticker)) {
    throw new Error("Enter a valid cashtag ticker.");
  }
  return ticker;
}

function normalizeStatus(value: string | null | undefined): SocialAlertHealthStatus {
  const text = String(value ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (
    text === "missing_token" ||
    text === "configured" ||
    text === "working" ||
    text === "expired" ||
    text === "rate_limited" ||
    text === "function_unreachable" ||
    text === "missing_config" ||
    text === "error"
  ) {
    return text;
  }
  if (text.includes("rate")) return "rate_limited";
  if (text.includes("expired") || text.includes("unauthorized") || text.includes("forbidden")) return "expired";
  return "error";
}

export function normalizeSocialHandle(raw: string): string {
  const value = String(raw ?? "").trim();
  let candidate = value;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host === "x.com" || host === "twitter.com") {
      candidate = url.pathname.split("/").filter(Boolean)[0] ?? "";
    }
  } catch {
    candidate = value;
  }
  candidate = candidate.replace(/^@+/, "").split(/[/?#]/)[0]?.trim() ?? "";
  if (!HANDLE_RE.test(candidate)) {
    throw new Error("Enter a valid public X/Twitter handle.");
  }
  return candidate.toLowerCase();
}

export function extractCashtags(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of String(text ?? "").matchAll(CASHTAG_RE)) {
    const ticker = String(match[2] ?? "").trim().toUpperCase();
    if (!ticker || /^\d+$/.test(ticker) || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push(ticker);
  }
  return out;
}

export function summarizeSocialAlertMetrics(rows: Array<{ cashtags: string[] }>, failures: number, runtimeMs: number): SocialAlertMetrics {
  const unique = new Set<string>();
  let cashtagHits = 0;
  for (const row of rows) {
    const perTweet = Array.from(new Set((row.cashtags ?? []).map((value) => value.toUpperCase()).filter(Boolean)));
    cashtagHits += perTweet.length;
    perTweet.forEach((ticker) => unique.add(ticker));
  }
  return {
    tweets: rows.length,
    cashtagHits,
    uniqueTickers: unique.size,
    failures,
    runtimeMs: Math.max(0, Math.round(runtimeMs || 0)),
  };
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

async function credentialCryptoKey(env: Env): Promise<CryptoKey> {
  const raw = env.SOCIAL_ALERTS_CREDENTIAL_KEY?.trim();
  if (!raw) throw new Error("SOCIAL_ALERTS_CREDENTIAL_KEY is not configured.");
  const bytes = base64ToBytes(raw);
  if (bytes.byteLength !== 32) throw new Error("SOCIAL_ALERTS_CREDENTIAL_KEY must be 32 bytes encoded as base64.");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptToken(env: Env, token: string): Promise<{ ciphertextBase64: string; ivBase64: string }> {
  const key = await credentialCryptoKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(token);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    ciphertextBase64: bytesToBase64(ciphertext),
    ivBase64: bytesToBase64(iv),
  };
}

async function decryptToken(env: Env, row: StoredCredentialRow): Promise<string> {
  const key = await credentialCryptoKey(env);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(row.ivBase64) },
    key,
    base64ToBytes(row.ciphertextBase64),
  );
  return new TextDecoder().decode(plaintext);
}

async function loadCredential(env: Env): Promise<StoredCredentialRow | null> {
  try {
    return await env.DB.prepare(
      "SELECT ciphertext_base64 as ciphertextBase64, iv_base64 as ivBase64, key_version as keyVersion, token_last4 as tokenLast4, status, last_validated_at as lastValidatedAt, updated_at as updatedAt FROM social_alert_credentials WHERE credential_key = ? LIMIT 1",
    )
      .bind(CREDENTIAL_KEY)
      .first<StoredCredentialRow>();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (message.toLowerCase().includes("no such table")) return null;
    throw error;
  }
}

function serviceTimeout(env: Env): number {
  const parsed = Number(env.SOCIAL_ALERTS_SCWEET_TIMEOUT_MS ?? DEFAULT_SERVICE_TIMEOUT_MS);
  return Number.isFinite(parsed) ? Math.max(5_000, Math.min(290_000, parsed)) : DEFAULT_SERVICE_TIMEOUT_MS;
}

function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.toLowerCase().includes("no such table");
}

async function callScweetService(
  env: Env,
  payload: Record<string, unknown>,
): Promise<ScweetServiceResponse> {
  const url = env.SOCIAL_ALERTS_SCWEET_URL?.trim();
  const token = env.SOCIAL_ALERTS_SCWEET_SERVICE_TOKEN?.trim();
  if (!url || !token) {
    return { ok: false, status: "missing_config", message: "SOCIAL_ALERTS_SCWEET_URL or SOCIAL_ALERTS_SCWEET_SERVICE_TOKEN is not configured." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), serviceTimeout(env));
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    let body: ScweetServiceResponse = {};
    try {
      body = bodyText ? JSON.parse(bodyText) as ScweetServiceResponse : {};
    } catch {
      body = { message: bodyText.slice(0, 240) };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: normalizeStatus(body.status ?? String(response.status)),
        message: body.message ?? `Scweet function failed (${response.status}).`,
      };
    }
    return { ok: body.ok !== false, ...body };
  } catch (error) {
    return {
      ok: false,
      status: "function_unreachable",
      message: error instanceof Error ? error.message : "Scweet function unreachable.",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function listSocialAlertHandles(env: Env): Promise<{ rows: SocialAlertSourceRow[] }> {
  const rows = await env.DB.prepare(
    "SELECT id, handle, display_name as displayName, is_active as isActive, last_scraped_at as lastScrapedAt, last_error as lastError, created_at as createdAt, updated_at as updatedAt FROM social_alert_sources ORDER BY is_active DESC, handle COLLATE NOCASE ASC",
  ).all<{
    id: string;
    handle: string;
    displayName: string | null;
    isActive: number;
    lastScrapedAt: string | null;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
  }>();
  return {
    rows: (rows.results ?? []).map((row) => ({
      ...row,
      isActive: Boolean(row.isActive),
    })),
  };
}

export async function createSocialAlertHandle(env: Env, body: unknown): Promise<{ ok: true; row: SocialAlertSourceRow }> {
  const payload = handleCreateSchema.parse(body);
  const handle = normalizeSocialHandle(payload.handle);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO social_alert_sources (id, handle, display_name, is_active, last_error, created_at, updated_at) VALUES (?, ?, ?, 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(handle) DO UPDATE SET is_active = 1, updated_at = CURRENT_TIMESTAMP",
  )
    .bind(id, handle, `@${handle}`)
    .run();
  const row = await env.DB.prepare(
    "SELECT id, handle, display_name as displayName, is_active as isActive, last_scraped_at as lastScrapedAt, last_error as lastError, created_at as createdAt, updated_at as updatedAt FROM social_alert_sources WHERE handle = ? COLLATE NOCASE LIMIT 1",
  )
    .bind(handle)
    .first<{
      id: string;
      handle: string;
      displayName: string | null;
      isActive: number;
      lastScrapedAt: string | null;
      lastError: string | null;
      createdAt: string;
      updatedAt: string;
    }>();
  if (!row) throw new Error("Failed to save social alert handle.");
  return {
    ok: true,
    row: {
      ...row,
      isActive: Boolean(row.isActive),
    },
  };
}

function mapSettingsRow(row: {
  id: string;
  dailyScrapeEnabled: number | null;
  dailyScrapeTimeLocal: string | null;
  dailyScrapeTimezone: string | null;
  dailyScrapeLookbackDays: number | null;
  updatedAt: string | null;
} | null): SocialAlertSettings {
  return {
    id: row?.id ?? DEFAULT_SETTINGS_ID,
    dailyScrapeEnabled: Number(row?.dailyScrapeEnabled ?? 0) === 1,
    dailyScrapeTimeLocal: row?.dailyScrapeTimeLocal ?? DEFAULT_DAILY_SCRAPE_TIME_LOCAL,
    dailyScrapeTimezone: row?.dailyScrapeTimezone ?? DEFAULT_DAILY_SCRAPE_TIMEZONE,
    dailyScrapeLookbackDays: Math.max(1, Math.min(DEFAULT_LOG_RETENTION_DAYS, Number(row?.dailyScrapeLookbackDays ?? DEFAULT_DAILY_SCRAPE_LOOKBACK_DAYS))),
    updatedAt: row?.updatedAt ?? nowIso(),
  };
}

async function ensureSocialAlertSettingsRow(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO social_alert_settings
      (id, daily_scrape_enabled, daily_scrape_time_local, daily_scrape_timezone, daily_scrape_lookback_days, updated_at)
     VALUES (?, 0, ?, ?, ?, CURRENT_TIMESTAMP)`,
  )
    .bind(DEFAULT_SETTINGS_ID, DEFAULT_DAILY_SCRAPE_TIME_LOCAL, DEFAULT_DAILY_SCRAPE_TIMEZONE, DEFAULT_DAILY_SCRAPE_LOOKBACK_DAYS)
    .run();
}

export async function getSocialAlertSettings(env: Env): Promise<SocialAlertSettings> {
  try {
    await ensureSocialAlertSettingsRow(env);
    const row = await env.DB.prepare(
      `SELECT
         id,
         daily_scrape_enabled as dailyScrapeEnabled,
         daily_scrape_time_local as dailyScrapeTimeLocal,
         daily_scrape_timezone as dailyScrapeTimezone,
         daily_scrape_lookback_days as dailyScrapeLookbackDays,
         updated_at as updatedAt
       FROM social_alert_settings
       WHERE id = ?
       LIMIT 1`,
    )
      .bind(DEFAULT_SETTINGS_ID)
      .first<{
        id: string;
        dailyScrapeEnabled: number | null;
        dailyScrapeTimeLocal: string | null;
        dailyScrapeTimezone: string | null;
        dailyScrapeLookbackDays: number | null;
        updatedAt: string | null;
      }>();
    return mapSettingsRow(row ?? null);
  } catch (error) {
    if (isMissingTableError(error)) return mapSettingsRow(null);
    throw error;
  }
}

export async function updateSocialAlertSettings(env: Env, body: unknown): Promise<{ ok: true; settings: SocialAlertSettings }> {
  const payload = settingsPatchSchema.parse(body);
  await ensureSocialAlertSettingsRow(env);
  await env.DB.prepare(
    `INSERT INTO social_alert_settings
      (id, daily_scrape_enabled, daily_scrape_time_local, daily_scrape_timezone, daily_scrape_lookback_days, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       daily_scrape_enabled = excluded.daily_scrape_enabled,
       daily_scrape_time_local = excluded.daily_scrape_time_local,
       daily_scrape_timezone = excluded.daily_scrape_timezone,
       daily_scrape_lookback_days = excluded.daily_scrape_lookback_days,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      DEFAULT_SETTINGS_ID,
      payload.dailyScrapeEnabled ? 1 : 0,
      payload.dailyScrapeTimeLocal,
      payload.dailyScrapeTimezone,
      payload.dailyScrapeLookbackDays,
    )
    .run();
  return { ok: true, settings: await getSocialAlertSettings(env) };
}

export async function listSocialAlertBlacklistedCashtags(env: Env): Promise<{ rows: SocialAlertBlacklistedCashtagRow[] }> {
  try {
    const rows = await env.DB.prepare(
      "SELECT ticker, reason, created_at as createdAt, updated_at as updatedAt FROM social_alert_blacklisted_cashtags ORDER BY ticker ASC",
    ).all<SocialAlertBlacklistedCashtagRow>();
    return { rows: rows.results ?? [] };
  } catch (error) {
    if (isMissingTableError(error)) return { rows: [] };
    throw error;
  }
}

export async function createSocialAlertBlacklistedCashtag(env: Env, body: unknown): Promise<{ ok: true; row: SocialAlertBlacklistedCashtagRow }> {
  const payload = blacklistCreateSchema.parse(body);
  await env.DB.prepare(
    `INSERT INTO social_alert_blacklisted_cashtags (ticker, reason, created_at, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(ticker) DO UPDATE SET reason = excluded.reason, updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(payload.ticker, payload.reason?.trim() || null)
    .run();
  const row = await env.DB.prepare(
    "SELECT ticker, reason, created_at as createdAt, updated_at as updatedAt FROM social_alert_blacklisted_cashtags WHERE ticker = ? LIMIT 1",
  )
    .bind(payload.ticker)
    .first<SocialAlertBlacklistedCashtagRow>();
  if (!row) throw new Error("Failed to save blacklisted cashtag.");
  return { ok: true, row };
}

export async function deleteSocialAlertBlacklistedCashtag(env: Env, ticker: string): Promise<{ ok: true; ticker: string }> {
  const normalized = normalizeCashtagTicker(ticker);
  await env.DB.prepare("DELETE FROM social_alert_blacklisted_cashtags WHERE ticker = ?")
    .bind(normalized)
    .run();
  return { ok: true, ticker: normalized };
}

async function loadBlacklistedCashtagSet(env: Env): Promise<Set<string>> {
  const rows = await listSocialAlertBlacklistedCashtags(env);
  return new Set(rows.rows.map((row) => row.ticker.toUpperCase()));
}

export async function saveSocialAlertCredential(env: Env, body: unknown): Promise<{
  ok: boolean;
  status: SocialAlertHealthStatus;
  tokenLast4: string | null;
  updatedAt: string;
  message: string | null;
}> {
  const payload = credentialSchema.parse(body);
  let status: SocialAlertHealthStatus = "configured";
  let message: string | null = null;
  if (payload.validate) {
    const validation = await callScweetService(env, {
      action: "validate",
      authToken: payload.authToken,
    });
    status = normalizeStatus(validation.status ?? (validation.ok ? "working" : "error"));
    message = validation.message ?? null;
    if (!validation.ok || status !== "working") {
      return {
        ok: false,
        status,
        tokenLast4: payload.authToken.slice(-4),
        updatedAt: nowIso(),
        message: message ?? "Scweet token validation failed.",
      };
    }
  }

  const encrypted = await encryptToken(env, payload.authToken);
  const updatedAt = nowIso();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO social_alert_credentials (credential_key, ciphertext_base64, iv_base64, key_version, token_last4, status, last_validated_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
  )
    .bind(CREDENTIAL_KEY, encrypted.ciphertextBase64, encrypted.ivBase64, payload.authToken.slice(-4), status, status === "working" ? updatedAt : null, updatedAt)
    .run();
  return {
    ok: true,
    status,
    tokenLast4: payload.authToken.slice(-4),
    updatedAt,
    message,
  };
}

export async function deleteSocialAlertCredential(env: Env): Promise<{ ok: true; status: SocialAlertHealthStatus }> {
  await env.DB.prepare("DELETE FROM social_alert_credentials WHERE credential_key = ?").bind(CREDENTIAL_KEY).run();
  return { ok: true, status: "missing_token" };
}

export async function getSocialAlertHealth(env: Env, options: { probe?: boolean; probeHandle?: string | null } = {}): Promise<{
  status: SocialAlertHealthStatus;
  tokenConfigured: boolean;
  tokenLast4: string | null;
  functionReachable: boolean;
  lastValidatedAt: string | null;
  updatedAt: string | null;
  message: string | null;
  scweetVersion?: string | null;
}> {
  const credential = await loadCredential(env);
  if (!credential) {
    return {
      status: "missing_token",
      tokenConfigured: false,
      tokenLast4: null,
      functionReachable: Boolean(env.SOCIAL_ALERTS_SCWEET_URL && env.SOCIAL_ALERTS_SCWEET_SERVICE_TOKEN),
      lastValidatedAt: null,
      updatedAt: null,
      message: "Paste and test a Scweet auth token before scraping.",
    };
  }

  if (!options.probe) {
    return {
      status: normalizeStatus(credential.status),
      tokenConfigured: true,
      tokenLast4: credential.tokenLast4,
      functionReachable: Boolean(env.SOCIAL_ALERTS_SCWEET_URL && env.SOCIAL_ALERTS_SCWEET_SERVICE_TOKEN),
      lastValidatedAt: credential.lastValidatedAt,
      updatedAt: credential.updatedAt,
      message: null,
    };
  }

  let authToken: string;
  try {
    authToken = await decryptToken(env, credential);
  } catch (error) {
    return {
      status: "error",
      tokenConfigured: true,
      tokenLast4: credential.tokenLast4,
      functionReachable: false,
      lastValidatedAt: credential.lastValidatedAt,
      updatedAt: credential.updatedAt,
      message: error instanceof Error ? error.message : "Unable to decrypt Scweet token.",
    };
  }
  const response = await callScweetService(env, {
    action: "validate",
    authToken,
    probeHandle: options.probeHandle ?? undefined,
  });
  const status = normalizeStatus(response.status ?? (response.ok ? "working" : "error"));
  const validatedAt = status === "working" ? nowIso() : credential.lastValidatedAt;
  await env.DB.prepare(
    "UPDATE social_alert_credentials SET status = ?, last_validated_at = ?, updated_at = CURRENT_TIMESTAMP WHERE credential_key = ?",
  )
    .bind(status, validatedAt, CREDENTIAL_KEY)
    .run();
  return {
    status,
    tokenConfigured: true,
    tokenLast4: credential.tokenLast4,
    functionReachable: status !== "function_unreachable" && status !== "missing_config",
    lastValidatedAt: validatedAt,
    updatedAt: nowIso(),
    message: response.message ?? null,
    scweetVersion: response.scweetVersion ?? null,
  };
}

async function selectedHandlesForRun(env: Env, payload: z.infer<typeof scrapeSchema>): Promise<SocialAlertSourceRow[]> {
  const all = await listSocialAlertHandles(env);
  const active = all.rows.filter((row) => row.isActive);
  const selected = payload.allHandles
    ? active
    : active.filter((row) => payload.handleIds.includes(row.id));
  const limited = selected.slice(0, MAX_HANDLES_PER_RUN);
  if (limited.length === 0) throw new Error("Select at least one saved handle to scrape.");
  return limited;
}

function normalizePost(handleFallback: string, post: ScweetPost): SocialAlertResultRow & { rawJson: string | null; canonicalKey: string } | null {
  let handle: string;
  try {
    handle = normalizeSocialHandle(String(post.handle ?? handleFallback));
  } catch {
    return null;
  }
  const text = String(post.text ?? "").trim();
  const url = String(post.url ?? "").trim();
  const tweetId = post.tweetId ? String(post.tweetId).trim() : null;
  if (!text || (!url && !tweetId)) return null;
  const finalUrl = url || `https://x.com/${handle}/status/${tweetId}`;
  const cashtags = extractCashtags(text);
  const canonicalKey = tweetId ? `id:${tweetId}` : `url:${finalUrl.toLowerCase()}`;
  let rawJson: string | null = null;
  try {
    rawJson = post.raw == null ? null : JSON.stringify(post.raw).slice(0, 40_000);
  } catch {
    rawJson = null;
  }
  const now = nowIso();
  return {
    id: crypto.randomUUID(),
    handle,
    tweetId,
    tweetCreatedAt: post.createdAt ? String(post.createdAt) : null,
    cashtags,
    text,
    url: finalUrl,
    firstSeenAt: now,
    lastSeenAt: now,
    rawJson,
    canonicalKey,
  };
}

async function upsertRunPost(env: Env, runId: string, row: SocialAlertResultRow & { rawJson: string | null; canonicalKey: string }): Promise<void> {
  const postId = row.id;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO social_alert_posts (id, canonical_key, tweet_id, tweet_url, handle, tweet_created_at, text, cashtags_json, first_seen_at, last_seen_at, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)",
  )
    .bind(postId, row.canonicalKey, row.tweetId, row.url, row.handle, row.tweetCreatedAt, row.text, JSON.stringify(row.cashtags), row.rawJson)
    .run();
  await env.DB.prepare(
    "UPDATE social_alert_posts SET last_seen_at = CURRENT_TIMESTAMP, cashtags_json = ?, text = ?, tweet_url = COALESCE(NULLIF(?, ''), tweet_url), raw_json = COALESCE(?, raw_json) WHERE canonical_key = ?",
  )
    .bind(JSON.stringify(row.cashtags), row.text, row.url, row.rawJson, row.canonicalKey)
    .run();
  const existing = await env.DB.prepare("SELECT id FROM social_alert_posts WHERE canonical_key = ? LIMIT 1")
    .bind(row.canonicalKey)
    .first<{ id: string }>();
  await env.DB.prepare("INSERT OR IGNORE INTO social_alert_run_posts (run_id, post_id, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
    .bind(runId, existing?.id ?? postId)
    .run();
}

export async function runSocialAlertScrape(env: Env, body: unknown): Promise<{
  ok: boolean;
  run: { id: string; status: string; startDate: string; limitPerHandle: number };
  metrics: SocialAlertMetrics;
  results: SocialAlertResultRow[];
  failures: ScweetFailure[];
  authStatus: { status: SocialAlertHealthStatus; message: string | null };
}>;
export async function runSocialAlertScrape(
  env: Env,
  body: unknown,
  options?: { trigger?: "manual" | "scheduled"; scheduledLocalDate?: string | null },
): Promise<{
  ok: boolean;
  run: { id: string; status: string; startDate: string; limitPerHandle: number };
  metrics: SocialAlertMetrics;
  results: SocialAlertResultRow[];
  failures: ScweetFailure[];
  authStatus: { status: SocialAlertHealthStatus; message: string | null };
}> {
  const payload = validateSocialAlertScrapePayload(body);
  const handles = await selectedHandlesForRun(env, payload);
  const runId = crypto.randomUUID();
  const trigger = options?.trigger ?? "manual";
  const scheduledLocalDate = trigger === "scheduled" ? options?.scheduledLocalDate ?? null : null;
  await env.DB.prepare(
    "INSERT INTO social_alert_runs (id, status, start_date, limit_per_handle, selected_handles_json, \"trigger\", scheduled_local_date, started_at, created_at) VALUES (?, 'running', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
  )
    .bind(runId, payload.startDate, payload.limitPerHandle, JSON.stringify(handles.map((row) => row.handle)), trigger, scheduledLocalDate)
    .run();

  try {
    const credential = await loadCredential(env);
    if (!credential) throw new Error("Scweet auth token is not configured.");
    const authToken = await decryptToken(env, credential);
    const started = Date.now();
    const response = await callScweetService(env, {
      action: "scrape",
      authToken,
      handles: handles.map((row) => row.handle),
      startDate: payload.startDate,
      limitPerHandle: payload.limitPerHandle,
    });
    const authStatus = normalizeStatus(response.status ?? (response.ok ? "working" : "error"));
    if (!response.ok) {
      await env.DB.prepare(
        "UPDATE social_alert_runs SET status = 'failed', auth_status = ?, error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
        .bind(authStatus, response.message ?? "Scweet scrape failed.", runId)
        .run();
      return {
        ok: false,
        run: { id: runId, status: "failed", startDate: payload.startDate, limitPerHandle: payload.limitPerHandle },
        metrics: { tweets: 0, cashtagHits: 0, uniqueTickers: 0, failures: handles.length, runtimeMs: Math.max(0, Date.now() - started) },
        results: [],
        failures: response.failures ?? [],
        authStatus: { status: authStatus, message: response.message ?? null },
      };
    }

    const rows: SocialAlertResultRow[] = [];
    const posts = response.posts ?? [];
    for (const post of posts) {
      const fallback = String(post.handle ?? handles[0]?.handle ?? "");
      const normalized = normalizePost(fallback, post);
      if (!normalized) continue;
      await upsertRunPost(env, runId, normalized);
      rows.push(normalized);
    }

    const failures = response.failures ?? [];
    const runtimeMs = Number(response.runtimeMs ?? Date.now() - started);
    const blacklist = await loadBlacklistedCashtagSet(env);
    const metrics = summarizeSocialAlertMetrics(
      rows.map((row) => ({ cashtags: row.cashtags.filter((ticker) => !blacklist.has(ticker.toUpperCase())) })),
      failures.length,
      runtimeMs,
    );
    await env.DB.prepare(
      "UPDATE social_alert_runs SET status = 'completed', auth_status = ?, tweets = ?, cashtag_hits = ?, unique_tickers = ?, failures = ?, runtime_ms = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
      .bind(authStatus, metrics.tweets, metrics.cashtagHits, metrics.uniqueTickers, metrics.failures, metrics.runtimeMs, runId)
      .run();

    for (const source of handles) {
      const failure = failures.find((item) => {
        try {
          return normalizeSocialHandle(String(item.handle ?? source.handle)) === source.handle;
        } catch {
          return false;
        }
      });
      await env.DB.prepare(
        "UPDATE social_alert_sources SET last_scraped_at = CURRENT_TIMESTAMP, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
        .bind(failure?.error ?? null, source.id)
        .run();
    }

    await env.DB.prepare(
      "UPDATE social_alert_credentials SET status = ?, last_validated_at = CASE WHEN ? = 'working' THEN CURRENT_TIMESTAMP ELSE last_validated_at END, updated_at = CURRENT_TIMESTAMP WHERE credential_key = ?",
    )
      .bind(authStatus, authStatus, CREDENTIAL_KEY)
      .run();

    return {
      ok: true,
      run: { id: runId, status: "completed", startDate: payload.startDate, limitPerHandle: payload.limitPerHandle },
      metrics,
      results: rows,
      failures,
      authStatus: { status: authStatus, message: response.message ?? null },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Social alerts scrape failed.";
    await env.DB.prepare(
      "UPDATE social_alert_runs SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
      .bind(message, runId)
      .run();
    return {
      ok: false,
      run: { id: runId, status: "failed", startDate: payload.startDate, limitPerHandle: payload.limitPerHandle },
      metrics: { tweets: 0, cashtagHits: 0, uniqueTickers: 0, failures: handles.length, runtimeMs: 0 },
      results: [],
      failures: handles.map((row) => ({ handle: row.handle, error: message })),
      authStatus: { status: "error", message },
    };
  }
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((value) => String(value).toUpperCase()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normalizeLogWindow(query: {
  startDate?: string | null;
  endDate?: string | null;
  lookbackDays?: number | null;
}, now = new Date()): { startDate: string; endDate: string; lookbackDays: number } {
  const requestedEnd = query.endDate && DATE_RE.test(query.endDate) ? query.endDate : defaultLogEndDate(now);
  const parsedLookback = Math.max(1, Math.min(DEFAULT_LOG_RETENTION_DAYS, Math.trunc(Number(query.lookbackDays ?? DEFAULT_LOG_RETENTION_DAYS) || DEFAULT_LOG_RETENTION_DAYS)));
  const requestedStart = query.startDate && DATE_RE.test(query.startDate)
    ? query.startDate
    : addDaysIso(requestedEnd, -(parsedLookback - 1));
  const startDate = requestedStart <= requestedEnd ? requestedStart : requestedEnd;
  const endDate = requestedStart <= requestedEnd ? requestedEnd : requestedStart;
  const msPerDay = 86_400_000;
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  const actualLookback = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(1, Math.min(DEFAULT_LOG_RETENTION_DAYS, Math.round((endMs - startMs) / msPerDay) + 1))
    : parsedLookback;
  return { startDate, endDate, lookbackDays: actualLookback };
}

function filterCashtagsForDisplay(cashtags: string[], blacklist: Set<string>): string[] {
  const seen = new Set<string>();
  const filtered: string[] = [];
  for (const ticker of cashtags) {
    const normalized = String(ticker ?? "").trim().toUpperCase();
    if (!normalized || blacklist.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    filtered.push(normalized);
  }
  return filtered;
}

function mentionFromRow(row: SocialAlertResultRow): SocialAlertMention {
  return {
    postId: row.id,
    handle: row.handle,
    tweetId: row.tweetId,
    tweetCreatedAt: row.tweetCreatedAt,
    text: row.text,
    url: row.url,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function buildTickerSummaries(rows: SocialAlertResultRow[]): SocialAlertTickerSummary[] {
  const byTicker = new Map<string, SocialAlertMention[]>();
  for (const row of rows) {
    for (const ticker of row.cashtags) {
      const mentions = byTicker.get(ticker) ?? [];
      mentions.push(mentionFromRow(row));
      byTicker.set(ticker, mentions);
    }
  }
  return Array.from(byTicker.entries())
    .map(([ticker, mentions]) => ({
      ticker,
      mentionCount: mentions.length,
      latestMention: mentions[0],
      mentions,
    }))
    .filter((row): row is SocialAlertTickerSummary => Boolean(row.latestMention))
    .sort((left, right) => right.mentionCount - left.mentionCount || left.ticker.localeCompare(right.ticker));
}

type SocialAlertRunRecord = {
  id: string;
  status: string;
  startDate: string;
  limitPerHandle: number;
  selectedHandlesJson: string | null;
  error: string | null;
  tweets: number | null;
  cashtagHits: number | null;
  uniqueTickers: number | null;
  failures: number | null;
  runtimeMs: number | null;
  trigger?: string | null;
  scheduledLocalDate?: string | null;
  createdAt: string;
  completedAt: string | null;
};

async function loadSocialAlertRunRecord(env: Env, runId?: string | null): Promise<SocialAlertRunRecord | null> {
  const selectRun =
    "SELECT id, status, start_date as startDate, limit_per_handle as limitPerHandle, selected_handles_json as selectedHandlesJson, error, tweets, cashtag_hits as cashtagHits, unique_tickers as uniqueTickers, failures, runtime_ms as runtimeMs, \"trigger\" as trigger, scheduled_local_date as scheduledLocalDate, created_at as createdAt, completed_at as completedAt FROM social_alert_runs";
  if (runId) {
    return await env.DB.prepare(`${selectRun} WHERE id = ? LIMIT 1`).bind(runId).first<SocialAlertRunRecord>();
  }
  return await env.DB.prepare(`${selectRun} ORDER BY datetime(created_at) DESC LIMIT 1`).first<SocialAlertRunRecord>();
}

export async function getSocialAlertResults(env: Env, query: {
  runId?: string | null;
  ticker?: string | null;
  handle?: string | null;
  q?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  lookbackDays?: number | null;
  limit?: number | null;
  offset?: number | null;
}): Promise<{
  run: {
    id: string;
    status: string;
    startDate: string;
    limitPerHandle: number;
    selectedHandles: string[];
    error: string | null;
    createdAt: string;
    completedAt: string | null;
    trigger?: string | null;
    scheduledLocalDate?: string | null;
  } | null;
  metrics: SocialAlertMetrics;
  rows: SocialAlertResultRow[];
  uniqueTickers: string[];
  tickerSummaries: SocialAlertTickerSummary[];
  blacklist: SocialAlertBlacklistedCashtagRow[];
  window: { startDate: string; endDate: string; lookbackDays: number };
  total: number;
  limit: number;
  offset: number;
}> {
  const run = await loadSocialAlertRunRecord(env, query.runId ?? null);
  const blacklistRows = await listSocialAlertBlacklistedCashtags(env);
  const blacklist = new Set(blacklistRows.rows.map((row) => row.ticker.toUpperCase()));
  const window = normalizeLogWindow(query);
  const requestedTicker = query.ticker?.trim() ? normalizeCashtagTicker(query.ticker) : null;
  const tickerIsBlacklisted = requestedTicker ? blacklist.has(requestedTicker) : false;

  const clauses = [
    "date(COALESCE(p.tweet_created_at, p.last_seen_at, p.first_seen_at)) >= date(?)",
    "date(COALESCE(p.tweet_created_at, p.last_seen_at, p.first_seen_at)) <= date(?)",
  ];
  const args: unknown[] = [window.startDate, window.endDate];
  if (query.runId?.trim()) {
    clauses.push("EXISTS (SELECT 1 FROM social_alert_run_posts rp WHERE rp.post_id = p.id AND rp.run_id = ?)");
    args.push(query.runId.trim());
  }
  if (query.handle?.trim()) {
    clauses.push("p.handle = ? COLLATE NOCASE");
    args.push(normalizeSocialHandle(query.handle));
  }
  if (query.q?.trim()) {
    clauses.push("p.text LIKE ?");
    args.push(`%${query.q.trim()}%`);
  }
  const where = clauses.join(" AND ");
  const limit = Math.max(1, Math.min(500, Number(query.limit ?? 200)));
  const offset = Math.max(0, Number(query.offset ?? 0));
  const rows = await env.DB.prepare(
    `SELECT p.id, p.handle, p.tweet_id as tweetId, p.tweet_created_at as tweetCreatedAt, p.cashtags_json as cashtagsJson, p.text, p.tweet_url as url, p.first_seen_at as firstSeenAt, p.last_seen_at as lastSeenAt
     FROM social_alert_posts p
     WHERE ${where}
     ORDER BY CASE WHEN datetime(p.tweet_created_at) IS NULL THEN 1 ELSE 0 END ASC, datetime(p.tweet_created_at) DESC, datetime(p.last_seen_at) DESC
     LIMIT ?`,
  )
    .bind(...args, MAX_LOG_QUERY_ROWS)
    .all<any>();

  const normalizedRows = (rows.results ?? []).map((row) => ({
    id: row.id,
    handle: row.handle,
    tweetId: row.tweetId ?? null,
    tweetCreatedAt: row.tweetCreatedAt ?? null,
    cashtags: filterCashtagsForDisplay(parseJsonArray(row.cashtagsJson), blacklist),
    text: row.text,
    url: row.url,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
  } satisfies SocialAlertResultRow));
  const filteredRows = tickerIsBlacklisted
    ? []
    : requestedTicker
      ? normalizedRows.filter((row) => row.cashtags.includes(requestedTicker))
      : normalizedRows;
  const pagedRows = filteredRows.slice(offset, offset + limit);
  const tickerSummaries = buildTickerSummaries(filteredRows);
  const uniqueTickers = tickerSummaries.map((row) => row.ticker);
  const metrics = summarizeSocialAlertMetrics(filteredRows.map((row) => ({ cashtags: row.cashtags })), Number(run?.failures ?? 0), Number(run?.runtimeMs ?? 0));

  return {
    run: run ? {
      id: run.id,
      status: run.status,
      startDate: run.startDate,
      limitPerHandle: run.limitPerHandle,
      selectedHandles: parseJsonArray(run.selectedHandlesJson).map((value) => value.toLowerCase()),
      error: run.error ?? null,
      createdAt: run.createdAt,
      completedAt: run.completedAt ?? null,
      trigger: run.trigger ?? "manual",
      scheduledLocalDate: run.scheduledLocalDate ?? null,
    } : null,
    metrics: {
      ...metrics,
      uniqueTickers: uniqueTickers.length,
    },
    rows: pagedRows,
    uniqueTickers,
    tickerSummaries,
    blacklist: blacklistRows.rows,
    window,
    total: filteredRows.length,
    limit,
    offset,
  };
}

export async function cleanupOldSocialAlertData(env: Env, retentionDays = DEFAULT_LOG_RETENTION_DAYS): Promise<{
  deletedRunPosts: number;
  deletedPosts: number;
  deletedRuns: number;
}> {
  const window = `-${Math.max(1, retentionDays)} day`;
  const deleteRunPosts = await env.DB.prepare(
    `DELETE FROM social_alert_run_posts
     WHERE post_id IN (
       SELECT id FROM social_alert_posts
       WHERE datetime(COALESCE(tweet_created_at, last_seen_at, first_seen_at)) < datetime('now', ?)
     )`,
  )
    .bind(window)
    .run();
  const deletePosts = await env.DB.prepare(
    "DELETE FROM social_alert_posts WHERE datetime(COALESCE(tweet_created_at, last_seen_at, first_seen_at)) < datetime('now', ?)",
  )
    .bind(window)
    .run();
  const deleteRuns = await env.DB.prepare(
    "DELETE FROM social_alert_runs WHERE datetime(created_at) < datetime('now', ?) AND id NOT IN (SELECT DISTINCT run_id FROM social_alert_run_posts)",
  )
    .bind(window)
    .run();
  return {
    deletedRunPosts: deleteRunPosts.meta?.changes ?? 0,
    deletedPosts: deletePosts.meta?.changes ?? 0,
    deletedRuns: deleteRuns.meta?.changes ?? 0,
  };
}

export function shouldRunScheduledSocialAlertScrape(now: Date, settings: SocialAlertSettings): { shouldRun: boolean; localDate: string } {
  if (!settings.dailyScrapeEnabled) {
    return { shouldRun: false, localDate: zonedParts(now, settings.dailyScrapeTimezone).localDate };
  }
  const target = parseLocalTime(settings.dailyScrapeTimeLocal) ?? { hour: 10, minute: 0 };
  const local = zonedParts(now, settings.dailyScrapeTimezone || DEFAULT_DAILY_SCRAPE_TIMEZONE);
  const targetMinutes = target.hour * 60 + target.minute;
  return {
    shouldRun: local.minutesOfDay >= targetMinutes,
    localDate: local.localDate,
  };
}

async function hasScheduledSocialAlertRunForDate(env: Env, localDate: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id FROM social_alert_runs WHERE \"trigger\" = 'scheduled' AND scheduled_local_date = ? LIMIT 1",
  )
    .bind(localDate)
    .first<{ id: string }>();
  return Boolean(row?.id);
}

export async function maybeRunScheduledSocialAlertScrape(env: Env, now = new Date()): Promise<{
  skipped: boolean;
  reason?: string;
  runId?: string;
  localDate?: string;
}> {
  const settings = await getSocialAlertSettings(env);
  const decision = shouldRunScheduledSocialAlertScrape(now, settings);
  if (!decision.shouldRun) return { skipped: true, reason: "not_due", localDate: decision.localDate };
  if (await hasScheduledSocialAlertRunForDate(env, decision.localDate)) {
    return { skipped: true, reason: "already_ran", localDate: decision.localDate };
  }
  const startDate = addDaysIso(decision.localDate, -settings.dailyScrapeLookbackDays);
  const result = await runSocialAlertScrape(env, {
    allHandles: true,
    startDate,
    limitPerHandle: DEFAULT_LIMIT_PER_HANDLE,
  }, {
    trigger: "scheduled",
    scheduledLocalDate: decision.localDate,
  });
  return {
    skipped: false,
    runId: result.run.id,
    localDate: decision.localDate,
  };
}
