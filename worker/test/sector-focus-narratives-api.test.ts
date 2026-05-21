import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

type FocusNarrativeRow = {
  id: string;
  sectorName: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

function createFocusNarrativesEnv(input: {
  sectorNames: string[];
  focusRows?: FocusNarrativeRow[];
  adminSecret?: string;
}): Env & { __focusRows: FocusNarrativeRow[] } {
  const sectorNames = [...input.sectorNames];
  const focusRows = [...(input.focusRows ?? [])];
  let idCounter = 0;

  const sortedFocusRows = (joinToEntries: boolean) => {
    const allowedNames = new Set(sectorNames);
    return [...focusRows]
      .filter((row) => !joinToEntries || allowedNames.has(row.sectorName))
      .sort((left, right) =>
        left.sortOrder - right.sortOrder ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.sectorName.localeCompare(right.sectorName),
      );
  };

  const env = {
    ADMIN_SECRET: input.adminSecret,
    DATA_PROVIDER: "alpaca",
    ALPACA_API_KEY: "test-key",
    ALPACA_API_SECRET: "test-secret",
    DB: {
      prepare(sql: string) {
        const makeStatement = (args: unknown[] = []) => ({
          __sql: sql,
          __args: args,
          bind(...nextArgs: unknown[]) {
            return makeStatement(nextArgs);
          },
          async all<T>() {
            if (sql.includes("FROM sector_focus_narratives f")) {
              return { results: sortedFocusRows(true) as T[] };
            }

            if (sql.includes("SELECT DISTINCT sector_name as sectorName FROM sector_tracker_entries")) {
              return {
                results: Array.from(new Set(sectorNames))
                  .sort((left, right) => left.localeCompare(right))
                  .map((sectorName) => ({ sectorName })) as T[],
              };
            }

            if (sql.includes("FROM sector_focus_narratives ORDER BY sort_order")) {
              return { results: sortedFocusRows(false) as T[] };
            }

            return { results: [] as T[] };
          },
          async first<T>() {
            return null as T;
          },
          async run() {
            if (sql === "DELETE FROM sector_focus_narratives") {
              focusRows.splice(0, focusRows.length);
              return {};
            }

            if (sql.includes("INSERT INTO sector_focus_narratives")) {
              const [id, sectorName, sortOrder] = args;
              const stamp = `2026-05-21T00:00:${String(++idCounter).padStart(2, "0")}Z`;
              focusRows.push({
                id: String(id),
                sectorName: String(sectorName),
                sortOrder: Number(sortOrder),
                createdAt: stamp,
                updatedAt: stamp,
              });
            }
            return {};
          },
        });
        return makeStatement();
      },
      async batch(statements: Array<{ run: () => Promise<unknown> }>) {
        for (const statement of statements) {
          await statement.run();
        }
        return [];
      },
    } as unknown as D1Database,
    __focusRows: focusRows,
  } as Env & { __focusRows: FocusNarrativeRow[] };

  return env;
}

describe("sector focus narratives API", () => {
  it("returns saved focus narratives in display order and omits stale names", async () => {
    const env = createFocusNarrativesEnv({
      sectorNames: ["Semiconductors", "Utilities", "Homebuilders"],
      focusRows: [
        { id: "f-utilities", sectorName: "Utilities", sortOrder: 2, createdAt: "2026-05-21T00:00:03Z", updatedAt: "2026-05-21T00:00:03Z" },
        { id: "f-stale", sectorName: "Stale Narrative", sortOrder: 1, createdAt: "2026-05-21T00:00:01Z", updatedAt: "2026-05-21T00:00:01Z" },
        { id: "f-homebuilders", sectorName: "Homebuilders", sortOrder: 1, createdAt: "2026-05-21T00:00:02Z", updatedAt: "2026-05-21T00:00:02Z" },
        { id: "f-semis", sectorName: "Semiconductors", sortOrder: 0, createdAt: "2026-05-21T00:00:04Z", updatedAt: "2026-05-21T00:00:04Z" },
      ],
    });

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/sectors/focus-narratives"),
      env as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { rows: FocusNarrativeRow[] };
    expect(body.rows.map((row) => row.sectorName)).toEqual(["Semiconductors", "Homebuilders", "Utilities"]);
  });

  it("replaces focus narratives with validated, deduplicated sector names", async () => {
    const env = createFocusNarrativesEnv({
      sectorNames: ["Semiconductors", "Utilities", "Homebuilders"],
      focusRows: [
        { id: "f-old", sectorName: "Homebuilders", sortOrder: 0, createdAt: "2026-05-21T00:00:00Z", updatedAt: "2026-05-21T00:00:00Z" },
      ],
    });

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/sectors/focus-narratives", {
        method: "PUT",
        body: JSON.stringify({ sectorNames: ["Utilities", "Missing", "Semiconductors", "Utilities", "", 42] }),
      }),
      env as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { rows: FocusNarrativeRow[] };
    expect(body.rows.map((row) => row.sectorName)).toEqual(["Utilities", "Semiconductors"]);
    expect(body.rows.map((row) => row.sortOrder)).toEqual([0, 1]);
    expect(env.__focusRows.map((row) => row.sectorName)).toEqual(["Utilities", "Semiconductors"]);
  });

  it("returns 400 when sectorNames is not an array", async () => {
    const env = createFocusNarrativesEnv({ sectorNames: ["Semiconductors"] });

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/sectors/focus-narratives", {
        method: "PUT",
        body: JSON.stringify({ sectorNames: "Semiconductors" }),
      }),
      env as never,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toContain("sectorNames");
  });

  it("requires auth for replacing focus narratives when ADMIN_SECRET is configured", async () => {
    const env = createFocusNarrativesEnv({ sectorNames: ["Semiconductors"], adminSecret: "secret" });

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/sectors/focus-narratives", {
        method: "PUT",
        body: JSON.stringify({ sectorNames: ["Semiconductors"] }),
      }),
      env as never,
    );

    expect(response.status).toBe(401);
    expect(env.__focusRows).toEqual([]);
  });
});
