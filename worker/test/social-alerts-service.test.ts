import { describe, expect, it } from "vitest";
import {
  deleteSocialAlertCredential,
  extractCashtags,
  getSocialAlertHealth,
  getSocialAlertResults,
  normalizeSocialHandle,
  saveSocialAlertCredential,
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
});
