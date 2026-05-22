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
