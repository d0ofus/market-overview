import { describe, expect, it } from "vitest";
import {
  clearProviderSymbolBackoff,
  loadActiveProviderBackoffTickers,
  recordProviderSymbolNoDataBackoff,
} from "../src/provider-backoff";
import type { Env } from "../src/types";

type BackoffRow = {
  providerKey: string;
  ticker: string;
  reason: string;
  failureCount: number;
  noDataUntil: string;
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  lastError: string | null;
};

class FakeBackoffDb {
  rows = new Map<string, BackoffRow>();

  prepare(sql: string) {
    const db = this;
    let bound: unknown[] = [];
    const normalized = sql.replace(/\s+/g, " ");
    const statement = {
      bind(...args: unknown[]) {
        bound = args;
        return statement;
      },
      async all<T>() {
        if (!normalized.includes("FROM provider_symbol_backoff")) return { results: [] as T[] };
        const provider = String(bound[0]);
        const until = String(bound.at(-1));
        const tickers = new Set(bound.slice(1, -1).map((value) => String(value)));
        return {
          results: Array.from(db.rows.values())
            .filter((row) => row.providerKey === provider && tickers.has(row.ticker) && row.noDataUntil > until)
            .map((row) => ({ ticker: row.ticker })) as T[],
        };
      },
      async run() {
        if (normalized.startsWith("UPDATE provider_symbol_backoff")) {
          const [noDataUntil, lastSuccessAt, provider, ...tickers] = bound;
          for (const tickerInput of tickers) {
            const key = `${provider}|${tickerInput}`;
            const row = db.rows.get(key);
            if (!row) continue;
            row.noDataUntil = String(noDataUntil);
            row.lastSuccessAt = String(lastSuccessAt);
            row.lastError = null;
          }
        }
        return {};
      },
    };
    return statement;
  }

  async batch(statements: Array<{ __statement?: unknown }>) {
    for (const statement of statements as Array<{ bindArgs?: unknown[] }>) {
      const args = statement.bindArgs ?? [];
      const [providerKey, ticker, reason, noDataUntil, lastAttemptAt, lastError] = args;
      const key = `${providerKey}|${ticker}`;
      const current = this.rows.get(key) ?? {
        providerKey: String(providerKey),
        ticker: String(ticker),
        reason: String(reason),
        failureCount: 0,
        noDataUntil: String(noDataUntil),
        lastAttemptAt: String(lastAttemptAt),
        lastSuccessAt: null,
        lastError: lastError == null ? null : String(lastError),
      };
      current.reason = String(reason);
      current.failureCount += 1;
      current.noDataUntil = String(noDataUntil);
      current.lastAttemptAt = String(lastAttemptAt);
      current.lastError = lastError == null ? null : String(lastError);
      this.rows.set(key, current);
    }
    return [];
  }
}

function createEnv(db: FakeBackoffDb): Env {
  const wrappedDb = {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return {
        bind(...args: unknown[]) {
          const bound = statement.bind(...args) as any;
          bound.bindArgs = args;
          return bound;
        },
      };
    },
    batch(statements: Array<{ bindArgs?: unknown[] }>) {
      return db.batch(statements);
    },
  };
  return { DB: wrappedDb as unknown as D1Database } as Env;
}

describe("provider symbol backoff", () => {
  it("marks no-data symbols for seven days and clears them on success", async () => {
    const db = new FakeBackoffDb();
    const env = createEnv(db);
    const now = new Date("2026-06-22T12:00:00.000Z");

    await recordProviderSymbolNoDataBackoff(env, "alpaca", ["AAA", "bbb"], "post_close_no_current_bar", 7, now);
    let active = await loadActiveProviderBackoffTickers(env, "alpaca", ["AAA", "BBB", "CCC"], now);

    expect(active).toEqual(new Set(["AAA", "BBB"]));
    expect(db.rows.get("alpaca|AAA")?.failureCount).toBe(1);

    await clearProviderSymbolBackoff(env, "alpaca", ["AAA"], new Date("2026-06-23T12:00:00.000Z"));
    active = await loadActiveProviderBackoffTickers(env, "alpaca", ["AAA", "BBB"], new Date("2026-06-23T12:00:01.000Z"));

    expect(active).toEqual(new Set(["BBB"]));
    expect(db.rows.get("alpaca|AAA")?.lastSuccessAt).toBe("2026-06-23T12:00:00.000Z");
  });
});
