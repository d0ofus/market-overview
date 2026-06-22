import type { Env } from "./types";

const DEFAULT_NO_DATA_BACKOFF_DAYS = 7;

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

function normalizeProvider(providerKey: string): string {
  return providerKey.trim().toLowerCase() || "unknown";
}

function canUseD1(env: Env): boolean {
  return Boolean(env.DB && typeof env.DB.prepare === "function");
}

function isMissingBackoffTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /provider_symbol_backoff|no such table/i.test(message);
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function loadActiveProviderBackoffTickers(
  env: Env,
  providerKey: string,
  tickers: string[],
  now = new Date(),
): Promise<Set<string>> {
  const unique = Array.from(new Set(tickers.map(normalizeTicker).filter(Boolean)));
  const out = new Set<string>();
  if (!canUseD1(env) || unique.length === 0) return out;
  const provider = normalizeProvider(providerKey);
  const nowIso = now.toISOString();
  try {
    for (const chunk of chunks(unique, 80)) {
      const placeholders = chunk.map(() => "?").join(",");
      const rows = await env.DB.prepare(
        `SELECT ticker
           FROM provider_symbol_backoff
          WHERE provider_key = ?
            AND ticker IN (${placeholders})
            AND no_data_until > ?`,
      ).bind(provider, ...chunk, nowIso).all<{ ticker: string }>();
      for (const row of rows.results ?? []) {
        const ticker = normalizeTicker(row.ticker);
        if (ticker) out.add(ticker);
      }
    }
  } catch (error) {
    if (!isMissingBackoffTable(error)) {
      console.warn("Provider backoff lookup failed", { providerKey: provider, error });
    }
  }
  return out;
}

export async function recordProviderSymbolNoDataBackoff(
  env: Env,
  providerKey: string,
  tickers: string[],
  reason: string,
  days = DEFAULT_NO_DATA_BACKOFF_DAYS,
  now = new Date(),
  lastError: string | null = null,
): Promise<void> {
  const unique = Array.from(new Set(tickers.map(normalizeTicker).filter(Boolean)));
  if (!canUseD1(env) || unique.length === 0) return;
  const provider = normalizeProvider(providerKey);
  const nowIso = now.toISOString();
  const noDataUntil = new Date(now.getTime() + Math.max(1, Math.floor(days)) * 24 * 60 * 60_000).toISOString();
  try {
    const statements = unique.map((ticker) => env.DB.prepare(
      `INSERT INTO provider_symbol_backoff
         (provider_key, ticker, reason, failure_count, no_data_until, last_attempt_at, last_success_at, last_error)
       VALUES (?, ?, ?, 1, ?, ?, NULL, ?)
       ON CONFLICT(provider_key, ticker) DO UPDATE SET
         reason = excluded.reason,
         failure_count = provider_symbol_backoff.failure_count + 1,
         no_data_until = excluded.no_data_until,
         last_attempt_at = excluded.last_attempt_at,
         last_error = excluded.last_error`,
    ).bind(provider, ticker, reason.slice(0, 120), noDataUntil, nowIso, lastError?.slice(0, 500) ?? null));
    await env.DB.batch(statements);
  } catch (error) {
    if (!isMissingBackoffTable(error)) {
      console.warn("Provider no-data backoff write failed", { providerKey: provider, count: unique.length, error });
    }
  }
}

export async function clearProviderSymbolBackoff(
  env: Env,
  providerKey: string,
  tickers: string[],
  now = new Date(),
): Promise<void> {
  const unique = Array.from(new Set(tickers.map(normalizeTicker).filter(Boolean)));
  if (!canUseD1(env) || unique.length === 0) return;
  const provider = normalizeProvider(providerKey);
  const nowIso = now.toISOString();
  try {
    for (const chunk of chunks(unique, 80)) {
      const placeholders = chunk.map(() => "?").join(",");
      await env.DB.prepare(
        `UPDATE provider_symbol_backoff
            SET no_data_until = ?,
                last_success_at = ?,
                last_error = NULL
          WHERE provider_key = ?
            AND ticker IN (${placeholders})`,
      ).bind(nowIso, nowIso, provider, ...chunk).run();
    }
  } catch (error) {
    if (!isMissingBackoffTable(error)) {
      console.warn("Provider backoff clear failed", { providerKey: provider, count: unique.length, error });
    }
  }
}
