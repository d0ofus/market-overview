import { describe, expect, it } from "vitest";
import {
  cleanupOldSocialAlertData,
  deleteSocialAlertCredential,
  extractCashtags,
  getSocialAlertHealth,
  getSocialAlertResults,
  getSocialAlertSettings,
  maybeRunScheduledSocialAlertScrape,
  normalizeSocialHandle,
  planScheduledSocialAlertScrape,
  saveSocialAlertCredential,
  shouldRunScheduledSocialAlertScrape,
  summarizeSocialAlertMetrics,
  validateSocialAlertScrapePayload,
} from "../src/social-alerts-service";
import type { Env } from "../src/types";

function base64TestKey(): string {
  const bytes = Array.from({ length: 32 }, (_, index) => index + 1);
  return btoa(String.fromCharCode(...bytes));
}

function createCredentialDb() {
  let credential: any = null;
  const statementFor = (sql: string, args: unknown[] = []): any => ({
    bind: (...nextArgs: unknown[]) => statementFor(sql, nextArgs),
    first: async () => {
      if (sql.includes("FROM social_alert_credentials")) return credential;
      return null;
    },
    all: async () => ({ results: [] }),
    run: async () => {
      if (sql.startsWith("INSERT OR REPLACE INTO social_alert_credentials")) {
        credential = {
          ciphertextBase64: args[1],
          ivBase64: args[2],
          keyVersion: 1,
          tokenLast4: args[3],
          status: args[4],
          lastValidatedAt: args[5],
          updatedAt: args[6],
        };
      } else if (sql.startsWith("DELETE FROM social_alert_credentials")) {
        credential = null;
      }
      return { success: true };
    },
  });
  return {
    db: {
      prepare: (sql: string) => statementFor(sql),
    } as unknown as D1Database,
    stored: () => credential,
  };
}

function createResultsDb() {
  const selectedPostQueries: string[] = [];
  const statementFor = (sql: string, args: unknown[] = []): any => ({
    bind: (...nextArgs: unknown[]) => statementFor(sql, nextArgs),
    first: async () => {
      if (sql.includes("FROM social_alert_runs")) {
        return {
          id: "run-1",
          status: "completed",
          startDate: "2026-05-01",
          limitPerHandle: 500,
          selectedHandlesJson: JSON.stringify(["sourcehandle"]),
          error: null,
          tweets: 3,
          cashtagHits: 3,
          uniqueTickers: 3,
          failures: 0,
          runtimeMs: 123,
          createdAt: "2026-05-05T00:00:00Z",
          completedAt: "2026-05-05T00:01:00Z",
        };
      }
      if (sql.includes("COUNT(*)")) return { count: 3 };
      return null;
    },
    all: async () => {
      if (sql.includes("SELECT p.id, p.handle")) {
        selectedPostQueries.push(sql);
        return { results: [
          { id: "p1", handle: "sourcehandle", tweetId: "1", tweetCreatedAt: "2026-05-05T13:00:00Z", cashtagsJson: JSON.stringify(["NVDA"]), text: "$NVDA", url: "https://x.com/sourcehandle/status/1", firstSeenAt: "2026-05-05T13:01:00Z", lastSeenAt: "2026-05-05T13:01:00Z" },
        ] };
      }
      if (sql.includes("SELECT p.cashtags_json")) {
        return { results: [{ cashtagsJson: JSON.stringify(["NVDA", "TSLA"]) }] };
      }
      return { results: [] };
    },
    run: async () => ({ success: true }),
  });
  return {
    db: {
      prepare: (sql: string) => statementFor(sql),
    } as unknown as D1Database,
    selectedPostQueries,
  };
}

function createRollingLogDb() {
  const selectedPostQueries: string[] = [];
  const statementFor = (sql: string, args: unknown[] = []): any => ({
    bind: (...nextArgs: unknown[]) => statementFor(sql, nextArgs),
    first: async () => {
      if (sql.includes("FROM social_alert_runs")) {
        return {
          id: "run-2",
          status: "completed",
          startDate: "2026-05-08",
          limitPerHandle: 50,
          selectedHandlesJson: JSON.stringify(["sourcehandle"]),
          error: null,
          tweets: 5,
          cashtagHits: 5,
          uniqueTickers: 3,
          failures: 1,
          runtimeMs: 2500,
          trigger: "manual",
          scheduledLocalDate: null,
          createdAt: "2026-05-10T00:00:00Z",
          completedAt: "2026-05-10T00:01:00Z",
        };
      }
      return null;
    },
    all: async () => {
      if (sql.includes("FROM social_alert_blacklisted_cashtags")) {
        return { results: [
          { ticker: "SPY", reason: "index", createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z" },
        ] };
      }
      if (sql.includes("FROM social_alert_posts p")) {
        selectedPostQueries.push(sql);
        return { results: [
          { id: "p1", handle: "sourcehandle", tweetId: "1", tweetCreatedAt: "2026-05-10T13:00:00Z", cashtagsJson: JSON.stringify(["NVDA", "SPY"]), text: "$NVDA $SPY", url: "https://x.com/sourcehandle/status/1", firstSeenAt: "2026-05-10T13:01:00Z", lastSeenAt: "2026-05-10T13:01:00Z" },
          { id: "p2", handle: "sourcehandle", tweetId: "2", tweetCreatedAt: "2026-05-09T13:00:00Z", cashtagsJson: JSON.stringify(["QQQ"]), text: "$QQQ", url: "https://x.com/sourcehandle/status/2", firstSeenAt: "2026-05-09T13:01:00Z", lastSeenAt: "2026-05-09T13:01:00Z" },
          { id: "p3", handle: "sourcehandle", tweetId: "3", tweetCreatedAt: "2026-05-08T13:00:00Z", cashtagsJson: JSON.stringify(["SPY"]), text: "$SPY only", url: "https://x.com/sourcehandle/status/3", firstSeenAt: "2026-05-08T13:01:00Z", lastSeenAt: "2026-05-08T13:01:00Z" },
          { id: "p4", handle: "sourcehandle", tweetId: "4", tweetCreatedAt: "2026-05-07T13:00:00Z", cashtagsJson: JSON.stringify([]), text: "no cashtags", url: "https://x.com/sourcehandle/status/4", firstSeenAt: "2026-05-07T13:01:00Z", lastSeenAt: "2026-05-07T13:01:00Z" },
          { id: "p5", handle: "sourcehandle", tweetId: "5", tweetCreatedAt: "2026-05-07T12:00:00Z", cashtagsJson: JSON.stringify(["QQQ"]), text: "older $QQQ", url: "https://x.com/sourcehandle/status/5", firstSeenAt: "2026-05-07T12:01:00Z", lastSeenAt: "2026-05-07T12:01:00Z" },
        ] };
      }
      return { results: [] };
    },
    run: async () => ({ success: true, meta: { changes: 0 } }),
  });
  return {
    db: {
      prepare: (sql: string) => statementFor(sql),
    } as unknown as D1Database,
    selectedPostQueries,
  };
}

function createCleanupDb() {
  const statements: string[] = [];
  return {
    db: {
      prepare(sql: string) {
        statements.push(sql);
        return {
          bind: () => ({
            run: async () => ({ meta: { changes: 1 } }),
          }),
        };
      },
    } as unknown as D1Database,
    statements,
  };
}

function createScheduledSettingsDb(existingScheduledRun: boolean, options: {
  enabled?: boolean;
  includeScrapeIntervalHours?: boolean;
  scrapeIntervalHours?: number | null;
  existingRunStatus?: string | null;
  existingRunStartedAt?: string | null;
} = {}) {
  const runLookupArgs: unknown[][] = [];
  const statementFor = (sql: string, args: unknown[] = []): any => ({
    bind: (...nextArgs: unknown[]) => statementFor(sql, nextArgs),
    first: async () => {
      if (sql.includes("FROM social_alert_settings")) {
        const row: Record<string, unknown> = {
          id: "default",
          dailyScrapeEnabled: options.enabled === false ? 0 : 1,
          dailyScrapeTimeLocal: "10:00",
          dailyScrapeTimezone: "Australia/Melbourne",
          dailyScrapeLookbackDays: 1,
          updatedAt: "2026-05-09T00:00:00Z",
        };
        if (options.includeScrapeIntervalHours !== false) {
          row.scrapeIntervalHours = options.scrapeIntervalHours ?? 6;
        }
        return row;
      }
      if (sql.includes("FROM social_alert_runs")) {
        runLookupArgs.push(args);
        return existingScheduledRun
          ? {
            id: "scheduled-run",
            status: options.existingRunStatus ?? "completed",
            startedAt: options.existingRunStartedAt ?? "2026-05-09T00:00:00Z",
          }
          : null;
      }
      return null;
    },
    all: async () => ({ results: [] }),
    run: async () => ({ success: true, meta: { changes: 0 } }),
  });
  return {
    env: {
      DB: {
        prepare: (sql: string) => statementFor(sql),
      } as unknown as D1Database,
    } as Env,
    runLookupArgs,
  };
}

describe("social alerts helpers", () => {
  it("normalizes X/Twitter handles from common input forms", () => {
    expect(normalizeSocialHandle("@MarketWizard_1")).toBe("marketwizard_1");
    expect(normalizeSocialHandle("https://x.com/NVDA/status/123")).toBe("nvda");
    expect(normalizeSocialHandle("https://twitter.com/TradeDesk?lang=en")).toBe("tradedesk");
    expect(() => normalizeSocialHandle("not a handle")).toThrow(/valid public/i);
    expect(() => normalizeSocialHandle("this_handle_is_too_long")).toThrow(/valid public/i);
  });

  it("extracts uppercase deduped stock cashtags", () => {
    expect(extractCashtags("$nvda and $TSLA, plus $BRK.B and again $NVDA")).toEqual(["NVDA", "TSLA", "BRK.B"]);
    expect(extractCashtags("Cash $100, crypto $BTC, malformed test$AMD and $SPY!")).toEqual(["BTC", "SPY"]);
  });

  it("summarizes scrape metrics from rows and failures", () => {
    const metrics = summarizeSocialAlertMetrics([
      { cashtags: ["NVDA", "TSLA"] },
      { cashtags: ["NVDA", "AMD", "AMD"] },
      { cashtags: [] },
    ], 2, 1234.4);
    expect(metrics).toEqual({
      tweets: 3,
      cashtagHits: 4,
      uniqueTickers: 3,
      failures: 2,
      runtimeMs: 1234,
    });
  });

  it("validates scrape API payload guardrails", () => {
    expect(validateSocialAlertScrapePayload({
      allHandles: true,
      startDate: "2026-05-01",
      limitPerHandle: 500,
    })).toMatchObject({ allHandles: true, startDate: "2026-05-01", limitPerHandle: 500 });
    expect(() => validateSocialAlertScrapePayload({ allHandles: true, startDate: "05-01-2026" })).toThrow();
    expect(() => validateSocialAlertScrapePayload({
      handleIds: Array.from({ length: 11 }, (_, index) => `h-${index}`),
      startDate: "2026-05-01",
    })).toThrow();
    expect(() => validateSocialAlertScrapePayload({ allHandles: true, startDate: "2026-05-01", limitPerHandle: 501 })).toThrow();
  });

  it("saves, reads, and deletes encrypted credentials without exposing plaintext", async () => {
    const store = createCredentialDb();
    const env = {
      DB: store.db,
      SOCIAL_ALERTS_CREDENTIAL_KEY: base64TestKey(),
      SOCIAL_ALERTS_SCWEET_URL: "https://example.test/api/social-alerts-scweet",
      SOCIAL_ALERTS_SCWEET_SERVICE_TOKEN: "service-token",
    } as Env;

    const saved = await saveSocialAlertCredential(env, { authToken: "auth-token-secret-1234", validate: false });
    expect(saved).toMatchObject({ ok: true, status: "configured", tokenLast4: "1234" });
    expect(store.stored().ciphertextBase64).not.toContain("auth-token-secret-1234");
    expect(store.stored().ivBase64).toBeTruthy();

    const health = await getSocialAlertHealth(env);
    expect(health).toMatchObject({
      status: "configured",
      tokenConfigured: true,
      tokenLast4: "1234",
      functionReachable: true,
    });

    await deleteSocialAlertCredential(env);
    expect((await getSocialAlertHealth(env)).status).toBe("missing_token");
  });

  it("uses deterministic newest-first SQL ordering with undated posts last", async () => {
    const store = createResultsDb();
    const env = { DB: store.db } as Env;

    await getSocialAlertResults(env, { limit: 10, offset: 0 });

    expect(store.selectedPostQueries[0]).toContain("CASE WHEN datetime(p.tweet_created_at) IS NULL THEN 1 ELSE 0 END ASC");
    expect(store.selectedPostQueries[0]).toContain("datetime(p.tweet_created_at) DESC");
    expect(store.selectedPostQueries[0]).toContain("datetime(p.last_seen_at) DESC");
  });

  it("returns a rolling deduped log with blacklist-aware metrics and ticker summaries", async () => {
    const store = createRollingLogDb();
    const env = { DB: store.db } as Env;

    const result = await getSocialAlertResults(env, {
      startDate: "2026-05-07",
      endDate: "2026-05-10",
      lookbackDays: 4,
      limit: 10,
      offset: 0,
    });

    expect(result.rows).toHaveLength(5);
    expect(result.total).toBe(5);
    expect(result.rows.map((row) => row.id)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(result.rows[0].cashtags).toEqual(["NVDA"]);
    expect(result.rows[2].cashtags).toEqual([]);
    expect(result.uniqueTickers).toEqual(["NVDA", "QQQ"]);
    expect(result.tickerSummaries).toHaveLength(2);
    expect(result.tickerSummaries.map((summary) => [summary.ticker, summary.mentionCount])).toEqual([["NVDA", 1], ["QQQ", 2]]);
    expect(result.tickerSummaries[0]?.latestMention).toMatchObject({ handle: "sourcehandle", text: "$NVDA $SPY" });
    expect(result.tickerSummaries[1]?.mentions.map((mention) => mention.postId)).toEqual(["p2", "p5"]);
    expect(result.metrics).toEqual({
      tweets: 5,
      cashtagHits: 3,
      uniqueTickers: 2,
      failures: 1,
      runtimeMs: 2500,
    });
    expect(result.blacklist.map((row) => row.ticker)).toEqual(["SPY"]);
    expect(result.window).toEqual({ startDate: "2026-05-07", endDate: "2026-05-10", lookbackDays: 4 });
    expect(store.selectedPostQueries[0]).toContain("FROM social_alert_posts p");
  });

  it("does not expose blacklisted cashtags through ticker filters", async () => {
    const env = { DB: createRollingLogDb().db } as Env;

    const result = await getSocialAlertResults(env, {
      ticker: "SPY",
      startDate: "2026-05-07",
      endDate: "2026-05-10",
      limit: 10,
      offset: 0,
    });

    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.uniqueTickers).toEqual([]);
    expect(result.metrics).toEqual({
      tweets: 0,
      cashtagHits: 0,
      uniqueTickers: 0,
      failures: 1,
      runtimeMs: 2500,
    });
  });

  it("cleans social alert log data older than the retention window", async () => {
    const store = createCleanupDb();

    const result = await cleanupOldSocialAlertData({ DB: store.db } as Env, 10);

    expect(result).toEqual({ deletedRunPosts: 1, deletedPosts: 1, deletedRuns: 1 });
    expect(store.statements[0]).toContain("DELETE FROM social_alert_run_posts");
    expect(store.statements[1]).toContain("DELETE FROM social_alert_posts");
    expect(store.statements[2]).toContain("DELETE FROM social_alert_runs");
  });

  it("decides when Melbourne scheduled social alert scrape slots are due every six hours", () => {
    const settings = {
      id: "default",
      dailyScrapeEnabled: true,
      dailyScrapeTimeLocal: "10:00",
      dailyScrapeTimezone: "Australia/Melbourne",
      dailyScrapeLookbackDays: 1,
      scrapeIntervalHours: 6,
      updatedAt: "2026-05-09T00:00:00Z",
    };

    expect(shouldRunScheduledSocialAlertScrape(new Date("2026-05-09T00:05:00Z"), settings)).toEqual({
      shouldRun: true,
      localDate: "2026-05-09",
      scheduledLocalSlot: "2026-05-09T10:00",
    });
    expect(shouldRunScheduledSocialAlertScrape(new Date("2026-05-09T06:05:00Z"), settings)).toEqual({
      shouldRun: true,
      localDate: "2026-05-09",
      scheduledLocalSlot: "2026-05-09T16:00",
    });
    expect(shouldRunScheduledSocialAlertScrape(new Date("2026-05-09T12:05:00Z"), settings)).toEqual({
      shouldRun: true,
      localDate: "2026-05-09",
      scheduledLocalSlot: "2026-05-09T22:00",
    });
    expect(shouldRunScheduledSocialAlertScrape(new Date("2026-05-09T18:05:00Z"), settings)).toEqual({
      shouldRun: true,
      localDate: "2026-05-10",
      scheduledLocalSlot: "2026-05-10T04:00",
    });
    expect(shouldRunScheduledSocialAlertScrape(new Date("2026-05-09T00:05:00Z"), {
      ...settings,
      dailyScrapeEnabled: false,
    })).toEqual({
      shouldRun: false,
      localDate: "2026-05-09",
      scheduledLocalSlot: null,
    });
  });

  it("defaults legacy social alert settings to a six-hour interval", async () => {
    const { env } = createScheduledSettingsDb(false, { includeScrapeIntervalHours: false });

    await expect(getSocialAlertSettings(env)).resolves.toMatchObject({
      scrapeIntervalHours: 6,
    });
  });

  it("plans due scheduled scrapes without running Scweet or claiming expensive work", async () => {
    const { env, runLookupArgs } = createScheduledSettingsDb(false);

    const result = await planScheduledSocialAlertScrape(env, new Date("2026-05-09T00:05:00Z"));

    expect(result).toEqual({
      skipped: false,
      localDate: "2026-05-09",
      scheduledLocalSlot: "2026-05-09T10:00",
      startDate: "2026-05-08",
      limitPerHandle: 50,
    });
    expect(runLookupArgs[0]).toEqual(["2026-05-09T10:00"]);
  });

  it("does not look for prior runs when scheduled social alerts are disabled", async () => {
    const { env, runLookupArgs } = createScheduledSettingsDb(false, { enabled: false });

    const result = await planScheduledSocialAlertScrape(env, new Date("2026-05-09T00:05:00Z"));

    expect(result).toEqual({
      skipped: true,
      reason: "not_due",
      localDate: "2026-05-09",
      scheduledLocalSlot: null,
    });
    expect(runLookupArgs).toEqual([]);
  });

  it("skips the scheduled scrape after it has already run for the Melbourne local slot", async () => {
    const { env, runLookupArgs } = createScheduledSettingsDb(true, {
      existingRunStatus: "running",
      existingRunStartedAt: "2026-05-09T00:00:00Z",
    });

    const result = await maybeRunScheduledSocialAlertScrape(env, new Date("2026-05-09T00:05:00Z"));

    expect(result).toEqual({
      skipped: true,
      reason: "already_ran",
      localDate: "2026-05-09",
      scheduledLocalSlot: "2026-05-09T10:00",
      existingRunId: "scheduled-run",
      existingRunStatus: "running",
      existingRunStartedAt: "2026-05-09T00:00:00Z",
    });
    expect(runLookupArgs[0]).toEqual(["2026-05-09T10:00"]);
  });
});
