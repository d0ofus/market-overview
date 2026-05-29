import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

function createSocialAlertsEnv(): Env {
  const statementFor = (sql: string, args: unknown[] = []): any => ({
    bind: (...nextArgs: unknown[]) => statementFor(sql, nextArgs),
    first: async () => {
      if (sql.includes("FROM social_alert_runs")) {
        return {
          id: "run-1",
          status: "completed",
          startDate: "2026-05-10",
          limitPerHandle: 50,
          selectedHandlesJson: JSON.stringify(["sourcehandle"]),
          error: null,
          failures: 0,
          runtimeMs: 2000,
          trigger: "manual",
          scheduledLocalDate: null,
          scheduledLocalSlot: null,
          createdAt: "2026-05-10T00:00:00Z",
          completedAt: "2026-05-10T00:01:00Z",
        };
      }
      return null;
    },
    all: async () => {
      if (sql.includes("FROM social_alert_blacklisted_cashtags")) {
        return {
          results: [
            { ticker: "SPY", reason: "index", createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z" },
          ],
        };
      }
      if (sql.includes("FROM social_alert_posts p")) {
        return {
          results: [
            {
              id: "post-1",
              handle: "sourcehandle",
              tweetId: "1",
              tweetCreatedAt: "2026-05-10T13:00:00Z",
              cashtagsJson: JSON.stringify(["NVDA", "SPY"]),
              text: "$NVDA $SPY",
              url: "https://x.com/sourcehandle/status/1",
              firstSeenAt: "2026-05-10T13:01:00Z",
              lastSeenAt: "2026-05-10T13:01:00Z",
            },
          ],
        };
      }
      return { results: [] };
    },
    run: async () => ({ success: true, meta: { changes: 0 }, args }),
  });

  return {
    ADMIN_SECRET: "secret",
    DB: {
      prepare: (sql: string) => statementFor(sql),
    } as unknown as D1Database,
  } as Env;
}

async function fetchWorker(path: string, init: RequestInit = {}) {
  return (worker as { fetch: typeof fetch }).fetch(new Request(`http://localhost${path}`, init), createSocialAlertsEnv() as never);
}

describe("social alerts API auth", () => {
  it("allows public results without exposing blacklist management rows", async () => {
    const response = await fetchWorker("/api/social-alerts/results?startDate=2026-05-10&endDate=2026-05-10&limit=10");
    const body = await response.json() as {
      blacklist?: unknown;
      rows: Array<{ cashtags: string[] }>;
      uniqueTickers: string[];
    };

    expect(response.status).toBe(200);
    expect(body.blacklist).toBeUndefined();
    expect(body.rows[0]?.cashtags).toEqual(["NVDA"]);
    expect(body.uniqueTickers).toEqual(["NVDA"]);
  });

  it("keeps social alerts admin routes protected", async () => {
    const cases: Array<{ path: string; init?: RequestInit }> = [
      { path: "/api/admin/social-alerts/results" },
      { path: "/api/admin/social-alerts/handles" },
      { path: "/api/admin/social-alerts/blacklist" },
      { path: "/api/admin/social-alerts/scrape", init: { method: "POST", body: JSON.stringify({ allHandles: true, startDate: "2026-05-10" }) } },
    ];

    for (const item of cases) {
      const response = await fetchWorker(item.path, item.init);
      const body = await response.json() as { error: string };

      expect(response.status).toBe(401);
      expect(body.error).toBe("Unauthorized");
    }
  });
});
