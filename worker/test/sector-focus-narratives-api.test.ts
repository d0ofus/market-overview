import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

type FocusRow = {
  id: string;
  sectorName: string;
  sortOrder: number;
  comment: string;
  sourceNarrativeName: string | null;
  sourcePeerGroupId: string | null;
  sourcePeerGroupName: string | null;
  manualName: string | null;
  selectedTickers: Array<{ ticker: string; name: string | null }>;
  createdAt: string;
  updatedAt: string;
};

type PeerFixture = { id: string; name: string; tickers: string[] };

function createEnv(input: {
  narratives: Record<string, string[]>;
  peers?: PeerFixture[];
  focusRows?: FocusRow[];
  adminSecret?: string;
}): Env & { __focusRows: FocusRow[] } {
  const focusRows = structuredClone(input.focusRows ?? []);
  const peers = input.peers ?? [];
  let stamp = 0;

  const statement = (sql: string, args: unknown[] = []): any => ({
    bind(...nextArgs: unknown[]) {
      return statement(sql, nextArgs);
    },
    async all<T>() {
      if (sql.includes("FROM sector_focus_narratives f") && sql.includes("LEFT JOIN peer_groups pg")) {
        return {
          results: [...focusRows]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map(({ selectedTickers: _selectedTickers, ...row }) => row) as T[],
        };
      }
      if (sql.includes("FROM sector_focus_narrative_symbols fs")) {
        return {
          results: focusRows.flatMap((row) => row.selectedTickers.map((item) => ({
            focusNarrativeId: row.id,
            ticker: item.ticker,
            name: item.name,
          }))) as T[],
        };
      }
      if (sql.includes("FROM sector_tracker_entries e") && sql.includes("sector_tracker_entry_symbols")) {
        return {
          results: Object.entries(input.narratives).flatMap<{ sectorName: string; ticker: string | null }>(([sectorName, tickers]) =>
            tickers.length > 0
              ? tickers.map((ticker) => ({ sectorName, ticker }))
              : [{ sectorName, ticker: null }],
          ) as unknown as T[],
        };
      }
      if (sql.includes("FROM peer_groups pg") && sql.includes("ticker_peer_groups")) {
        return {
          results: peers.flatMap<{ id: string; name: string; ticker: string | null }>((peer) => peer.tickers.length > 0
            ? peer.tickers.map((ticker) => ({ id: peer.id, name: peer.name, ticker }))
            : [{ id: peer.id, name: peer.name, ticker: null }]) as unknown as T[],
        };
      }
      if (sql.includes("FROM sector_focus_narratives f") && sql.includes("sector_focus_narrative_symbols fs")) {
        return {
          results: focusRows.flatMap((row) => {
            const values = row.selectedTickers.length > 0 ? row.selectedTickers : [{ ticker: null, name: null }];
            return values.map((item) => ({
              id: row.id,
              sectorName: row.sectorName,
              comment: row.comment,
              sourceNarrativeName: row.sourceNarrativeName,
              sourcePeerGroupId: row.sourcePeerGroupId,
              manualName: row.manualName,
              ticker: item.ticker,
            }));
          }) as T[],
        };
      }
      return { results: [] as T[] };
    },
    async first<T>() {
      return null as T;
    },
    async run() {
      if (sql === "DELETE FROM sector_focus_narrative_symbols") {
        for (const row of focusRows) row.selectedTickers = [];
      } else if (sql === "DELETE FROM sector_focus_narratives") {
        focusRows.splice(0, focusRows.length);
      } else if (sql.includes("INSERT INTO sector_focus_narratives")) {
        const rows = JSON.parse(String(args[0] ?? "[]")) as Array<{
          id: string;
          sectorName: string;
          sortOrder: number;
          comment: string;
          sourceNarrativeName: string | null;
          sourcePeerGroupId: string | null;
          manualName: string | null;
        }>;
        for (const row of rows) {
          const sourcePeerGroupName = peers.find((peer) => peer.id === row.sourcePeerGroupId)?.name ?? null;
          const createdAt = `2026-07-17T00:00:${String(++stamp).padStart(2, "0")}Z`;
          focusRows.push({
            ...row,
            sourcePeerGroupName,
            selectedTickers: [],
            createdAt,
            updatedAt: createdAt,
          });
        }
      } else if (sql.includes("INSERT INTO sector_focus_narrative_symbols")) {
        const links = JSON.parse(String(args[0] ?? "[]")) as Array<{ focusNarrativeId: string; ticker: string }>;
        for (const link of links) {
          focusRows.find((row) => row.id === link.focusNarrativeId)?.selectedTickers.push({ ticker: link.ticker, name: link.ticker });
        }
      }
      return {};
    },
  });

  return {
    ADMIN_SECRET: input.adminSecret,
    DATA_PROVIDER: "alpaca",
    ALPACA_API_KEY: "test-key",
    ALPACA_API_SECRET: "test-secret",
    DB: {
      prepare(sql: string) {
        return statement(sql);
      },
      async batch(statements: Array<{ run: () => Promise<unknown> }>) {
        for (const item of statements) await item.run();
        return [];
      },
    } as unknown as D1Database,
    __focusRows: focusRows,
  } as Env & { __focusRows: FocusRow[] };
}

const initialRow = (overrides: Partial<FocusRow> = {}): FocusRow => ({
  id: "focus-ai",
  sectorName: "AI Infrastructure",
  sortOrder: 0,
  comment: "Watch capex",
  sourceNarrativeName: "AI Infrastructure",
  sourcePeerGroupId: null,
  sourcePeerGroupName: null,
  manualName: null,
  selectedTickers: [{ ticker: "NVDA", name: "NVIDIA" }, { ticker: "VRT", name: "Vertiv" }],
  createdAt: "2026-07-17T00:00:00Z",
  updatedAt: "2026-07-17T00:00:00Z",
  ...overrides,
});

describe("sector focus narratives API", () => {
  it("returns custom names and exact selected tickers", async () => {
    const env = createEnv({ narratives: { "AI Infrastructure": ["NVDA", "VRT", "AVGO"] }, focusRows: [initialRow({ sectorName: "My AI Mix", manualName: "My AI Mix" })] });
    const response = await (worker as { fetch: typeof fetch }).fetch(new Request("http://localhost/api/sectors/focus-narratives"), env as never);
    expect(response.status).toBe(200);
    const body = await response.json() as { rows: FocusRow[] };
    expect(body.rows[0].sectorName).toBe("My AI Mix");
    expect(body.rows[0].selectedTickers.map((row) => row.ticker)).toEqual(["NVDA", "VRT"]);
  });

  it("persists an exact narrative subset instead of the full universe", async () => {
    const env = createEnv({ narratives: { "AI Infrastructure": ["NVDA", "VRT", "AVGO"] } });
    const response = await (worker as { fetch: typeof fetch }).fetch(new Request("http://localhost/api/sectors/focus-narratives", {
      method: "PUT",
      body: JSON.stringify({ focusNarratives: [{ sourceNarrativeName: "AI Infrastructure", selectedTickers: ["NVDA", "VRT"], comment: "Subset" }] }),
    }), env as never);
    expect(response.status).toBe(200);
    expect(env.__focusRows[0].sectorName).toBe("AI Infrastructure");
    expect(env.__focusRows[0].selectedTickers.map((row) => row.ticker)).toEqual(["NVDA", "VRT"]);
  });

  it("uses peer-group precedence when both sources contain the selection", async () => {
    const env = createEnv({
      narratives: { "AI Infrastructure": ["NVDA", "AVGO", "VRT"] },
      peers: [{ id: "pg-semis", name: "Semiconductors", tickers: ["NVDA", "AVGO", "AMD"] }],
    });
    const response = await (worker as { fetch: typeof fetch }).fetch(new Request("http://localhost/api/sectors/focus-narratives", {
      method: "PUT",
      body: JSON.stringify({ focusNarratives: [{ sourceNarrativeName: "AI Infrastructure", sourcePeerGroupId: "pg-semis", selectedTickers: ["NVDA", "AVGO"] }] }),
    }), env as never);
    expect(response.status).toBe(200);
    expect(env.__focusRows[0].sectorName).toBe("Semiconductors");
  });

  it("requires a manual name for mixed membership and leaves existing rows untouched", async () => {
    const env = createEnv({
      narratives: { "AI Infrastructure": ["NVDA", "VRT"] },
      peers: [{ id: "pg-semis", name: "Semiconductors", tickers: ["NVDA", "AMD"] }],
      focusRows: [initialRow()],
    });
    const response = await (worker as { fetch: typeof fetch }).fetch(new Request("http://localhost/api/sectors/focus-narratives", {
      method: "PUT",
      body: JSON.stringify({ focusNarratives: [{ sourceNarrativeName: "AI Infrastructure", sourcePeerGroupId: "pg-semis", selectedTickers: ["VRT", "AMD"] }] }),
    }), env as never);
    expect(response.status).toBe(400);
    expect(env.__focusRows.map((row) => row.id)).toEqual(["focus-ai"]);
  });

  it("preserves selected membership on reorder/comment writes", async () => {
    const env = createEnv({ narratives: { "AI Infrastructure": ["NVDA", "VRT", "AVGO"], Utilities: ["NEE"] }, focusRows: [initialRow()] });
    const response = await (worker as { fetch: typeof fetch }).fetch(new Request("http://localhost/api/sectors/focus-narratives", {
      method: "PUT",
      body: JSON.stringify({ focusNarratives: [{
        id: "focus-ai",
        sectorName: "AI Infrastructure",
        sourceNarrativeName: "AI Infrastructure",
        sourcePeerGroupId: null,
        manualName: null,
        selectedTickers: ["NVDA", "VRT"],
        comment: "Updated",
      }] }),
    }), env as never);
    expect(response.status).toBe(200);
    expect(env.__focusRows[0].comment).toBe("Updated");
    expect(env.__focusRows[0].selectedTickers.map((row) => row.ticker)).toEqual(["NVDA", "VRT"]);
  });

  it("keeps legacy sectorNames behavior by filtering invalid and duplicate names", async () => {
    const env = createEnv({ narratives: { "AI Infrastructure": ["NVDA", "VRT"], Utilities: ["NEE"] } });
    const response = await (worker as { fetch: typeof fetch }).fetch(new Request("http://localhost/api/sectors/focus-narratives", {
      method: "PUT",
      body: JSON.stringify({ sectorNames: ["Utilities", "Missing", "AI Infrastructure", "Utilities", 42] }),
    }), env as never);
    expect(response.status).toBe(200);
    expect(env.__focusRows.map((row) => row.sectorName)).toEqual(["Utilities", "AI Infrastructure"]);
    expect(env.__focusRows.map((row) => row.selectedTickers.map((item) => item.ticker))).toEqual([["NEE"], ["NVDA", "VRT"]]);
  });

  it("requires auth when ADMIN_SECRET is configured", async () => {
    const env = createEnv({ narratives: { "AI Infrastructure": ["NVDA"] }, adminSecret: "secret" });
    const response = await (worker as { fetch: typeof fetch }).fetch(new Request("http://localhost/api/sectors/focus-narratives", {
      method: "PUT",
      body: JSON.stringify({ focusNarratives: [] }),
    }), env as never);
    expect(response.status).toBe(401);
  });
});
