import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

function createMissingSchemaEnv(): Env {
  return {
    ADMIN_SECRET: "secret",
    DB: {
      prepare(sql: string) {
        const statement = {
          async first<T>() {
            if (sql.includes("sqlite_master")) return { count: 0 } as T;
            return null as T;
          },
          async all<T>() {
            return { results: [] as T[] };
          },
          async run() {
            return {};
          },
        };
        return {
          bind() {
            return statement;
          },
          ...statement,
        };
      },
      async batch() {
        return [];
      },
    } as unknown as D1Database,
  };
}

function createMissingGapSeasonEnv(): Env {
  return {
    ADMIN_SECRET: "secret",
    DB: {
      prepare(sql: string) {
        const statement = {
          async first<T>() {
            if (sql.includes("sqlite_master")) return { count: 1 } as T;
            if (sql.includes("pragma_table_info")) return { count: 0 } as T;
            return null as T;
          },
          async all<T>() {
            return { results: [] as T[] };
          },
          async run() {
            return {};
          },
        };
        return {
          bind() {
            return statement;
          },
          ...statement,
        };
      },
      async batch() {
        return [];
      },
    } as unknown as D1Database,
  };
}

function createExportEnv(): Env {
  return {
    ADMIN_SECRET: "secret",
    DB: {
      prepare(sql: string) {
        const statement = {
          async first<T>() {
            if (sql.includes("sqlite_master")) return { count: 1 } as T;
            if (sql.includes("pragma_table_info")) return { count: 1 } as T;
            return null as T;
          },
          async all<T>() {
            if (sql.includes("SELECT ticker")) {
              return { results: [{ ticker: "AAA" }, { ticker: "BBB" }] as T[] };
            }
            return { results: [] as T[] };
          },
          async run() {
            return {};
          },
        };
        return {
          bind() {
            return statement;
          },
          ...statement,
        };
      },
      async batch() {
        return [];
      },
    } as unknown as D1Database,
  };
}

function createAdminExclusionsEnv(): Env {
  const excludedRows = [
    {
      id: "pref",
      provider: "tradingview",
      sourceSymbol: "NASDAQ:FBIOP",
      ticker: "FBIOP",
      exchange: "NASDAQ",
      companyName: "Fortress Biotech Series A Cumulative Redeemable Perpetual Preferred Stock",
      reportDate: "2026-05-01",
      metricValue: 50,
      catalogIsActive: null,
      catalogManaged: null,
      listingSource: null,
      assetClass: null,
    },
    {
      id: "debt",
      provider: "tradingview",
      sourceSymbol: "NYSE:ABCN",
      ticker: "ABCN",
      exchange: "NYSE",
      companyName: "ABC Holdings 6.250% Senior Notes due 2030",
      reportDate: "2026-05-02",
      metricValue: 40,
      catalogIsActive: null,
      catalogManaged: null,
      listingSource: null,
      assetClass: null,
    },
    {
      id: "otc",
      provider: "tradingview",
      sourceSymbol: "OTC:OTCM",
      ticker: "OTCM",
      exchange: "OTC",
      companyName: "OTC Markets Group Inc.",
      reportDate: "2026-05-03",
      metricValue: 30,
      catalogIsActive: null,
      catalogManaged: null,
      listingSource: null,
      assetClass: null,
    },
  ];
  return {
    ADMIN_SECRET: "secret",
    DB: {
      prepare(sql: string) {
        const statement = {
          async first<T>() {
            if (sql.includes("sqlite_master")) return { count: 1 } as T;
            if (sql.includes("pragma_table_info")) return { count: 0 } as T;
            if (sql.includes("SELECT COUNT(*) as count") && sql.includes("FROM earnings_surprise_events")) {
              return { count: excludedRows.length } as T;
            }
            return null as T;
          },
          async all<T>() {
            if (sql.includes("FROM earnings_surprise_events")) return { results: excludedRows as T[] };
            return { results: [] as T[] };
          },
          async run() {
            return {};
          },
        };
        return {
          bind() {
            return statement;
          },
          ...statement,
        };
      },
      async batch() {
        return [];
      },
    } as unknown as D1Database,
  };
}

describe("earnings surprise API", () => {
  it("returns a schema warning from the public list endpoint before migration", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/earnings/surprises?limit=10"),
      createMissingSchemaEnv(),
      {} as ExecutionContext,
    );
    const json = await res.json() as { schemaReady?: boolean; warning?: string };

    expect(res.status).toBe(200);
    expect(json.schemaReady).toBe(false);
    expect(json.warning).toContain("0051_earnings_surprises.sql");
  });

  it("returns a schema warning from the public status endpoint before migration", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/earnings/surprises/status"),
      createMissingSchemaEnv(),
      {} as ExecutionContext,
    );
    const json = await res.json() as { schemaReady?: boolean; warning?: string };

    expect(res.status).toBe(200);
    expect(json.schemaReady).toBe(false);
    expect(json.warning).toContain("0051_earnings_surprises.sql");
  });

  it("returns a schema warning from the public gap endpoint before migration", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/earnings/gaps?limit=10"),
      createMissingSchemaEnv(),
      {} as ExecutionContext,
    );
    const json = await res.json() as { schemaReady?: boolean; warning?: string };

    expect(res.status).toBe(200);
    expect(json.schemaReady).toBe(false);
    expect(json.warning).toContain("0052_earnings_gaps.sql");
  });

  it("returns a season schema warning from the public gap endpoint before the season migration", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/earnings/gaps?limit=10&season=2026%20Q2"),
      createMissingGapSeasonEnv(),
      {} as ExecutionContext,
    );
    const json = await res.json() as { schemaReady?: boolean; warning?: string };

    expect(res.status).toBe(200);
    expect(json.schemaReady).toBe(false);
    expect(json.warning).toContain("0054_earnings_gap_season.sql");
  });

  it("exports surprise tickers as TXT with the requested day-month filename", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/earnings/surprises/export.txt?limit=2&dateSuffix=2026-05-22"),
      createExportEnv(),
      {} as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("Content-Disposition")).toContain("Earnings_Surprise_22_05.txt");
    expect(await res.text()).toBe("AAA\nBBB");
  });

  it("exports gap tickers as TXT with the requested day-month filename", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/earnings/gaps/export.txt?limit=2&dateSuffix=2026-05-22"),
      createExportEnv(),
      {} as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("Content-Disposition")).toContain("Earnings_GapUp_22_05.txt");
    expect(await res.text()).toBe("AAA\nBBB");
  });

  it("protects the admin gap sync endpoint", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/admin/earnings/gaps/sync", { method: "POST" }),
      createMissingSchemaEnv(),
      {} as ExecutionContext,
    );

    expect(res.status).toBe(401);
  });

  it("protects the admin sync endpoint", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/admin/earnings/surprises/sync", { method: "POST" }),
      createMissingSchemaEnv(),
      {} as ExecutionContext,
    );

    expect(res.status).toBe(401);
  });

  it("returns admin earnings exclusions with classifier reasons", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/admin/earnings/exclusions?dataset=surprises&limit=10", {
        headers: { Authorization: "Bearer secret" },
      }),
      createAdminExclusionsEnv(),
      {} as ExecutionContext,
    );
    const json = await res.json() as {
      total?: number;
      rows?: Array<{ ticker: string; reasons: string[] }>;
    };

    expect(res.status).toBe(200);
    expect(json.total).toBe(3);
    expect(json.rows?.find((row) => row.ticker === "FBIOP")?.reasons).toContain("Preferred/security text");
    expect(json.rows?.find((row) => row.ticker === "ABCN")?.reasons).toContain("Debt/bond/note security text");
    expect(json.rows?.find((row) => row.ticker === "OTCM")?.reasons).toContain("OTC or non-major exchange");
  });

  it("surfaces missing schema from the authorized admin sync endpoint", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/admin/earnings/surprises/sync", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
      }),
      createMissingSchemaEnv(),
      {} as ExecutionContext,
    );
    const json = await res.json() as { error?: string };

    expect(res.status).toBe(500);
    expect(json.error).toContain("0051_earnings_surprises.sql");
  });

  it("surfaces missing schema from the authorized admin gap sync endpoint", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/admin/earnings/gaps/sync", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
      }),
      createMissingSchemaEnv(),
      {} as ExecutionContext,
    );
    const json = await res.json() as { error?: string };

    expect(res.status).toBe(500);
    expect(json.error).toContain("0052_earnings_gaps.sql");
  });
});
