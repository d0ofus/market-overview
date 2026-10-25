import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("targeted Focus Now deletion against migrated SQLite", () => {
  let storage: ReturnType<typeof createSqliteD1>;
  const protectedTables = ["symbols", "peer_groups", "ticker_peer_groups", "sector_tracker_entries", "sector_tracker_entry_symbols"];
  const tables = ["sector_focus_narratives", "sector_focus_narrative_symbols", ...protectedTables];

  beforeEach(() => {
    storage = createSqliteD1();
    storage.script(`
      CREATE TABLE symbols (ticker TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE peer_groups (id TEXT PRIMARY KEY, name TEXT, is_active INTEGER);
      CREATE TABLE ticker_peer_groups (peer_group_id TEXT REFERENCES peer_groups(id), ticker TEXT REFERENCES symbols(ticker));
      CREATE TABLE sector_tracker_entries (id TEXT PRIMARY KEY, sector_name TEXT);
      CREATE TABLE sector_tracker_entry_symbols (entry_id TEXT REFERENCES sector_tracker_entries(id), ticker TEXT REFERENCES symbols(ticker));
      ${readFileSync("migrations/0053_sector_focus_narratives.sql", "utf8")}
      ${readFileSync("migrations/0065_sector_focus_narrative_comments.sql", "utf8")}
      ${readFileSync("migrations/0090_sector_focus_selected_tickers.sql", "utf8")}
      INSERT INTO symbols VALUES ('NVDA', 'NVIDIA'), ('VRT', 'Vertiv'), ('NEE', 'NextEra'), ('AMD', 'AMD');
      INSERT INTO peer_groups VALUES ('pg-semis', 'Semiconductors', 1);
      INSERT INTO ticker_peer_groups VALUES ('pg-semis', 'NVDA'), ('pg-semis', 'AMD');
      INSERT INTO sector_tracker_entries VALUES ('entry-ai', 'AI Infrastructure'), ('entry-util', 'Utilities');
      INSERT INTO sector_tracker_entry_symbols VALUES ('entry-ai', 'NVDA'), ('entry-util', 'NEE');
      INSERT INTO sector_focus_narratives
        (id, sector_name, sort_order, comment_text, source_narrative_name, source_peer_group_id, manual_name, created_at, updated_at)
      VALUES
        ('focus-stale', 'AI Infrastructure', 0, 'Keep this comment', 'AI Infrastructure', NULL, NULL, '2026-07-17 00:00:00', '2026-07-18 00:00:00'),
        ('focus-delete', 'Utilities', 3, 'Delete this entry', 'Utilities', NULL, NULL, '2026-07-19 00:00:00', '2026-07-20 00:00:00'),
        ('focus-later', 'My AMD selection', 9, 'Keep this too', NULL, 'pg-semis', 'My AMD selection', '2026-07-21 00:00:00', '2026-07-22 00:00:00');
      INSERT INTO sector_focus_narrative_symbols (focus_narrative_id, ticker, sort_order, created_at)
      VALUES ('focus-stale', 'VRT', 0, '2026-07-17 00:00:00'), ('focus-stale', 'NVDA', 1, '2026-07-17 00:00:00'),
        ('focus-delete', 'NEE', 0, '2026-07-19 00:00:00'), ('focus-later', 'AMD', 0, '2026-07-21 00:00:00');
    `);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    storage.dispose();
  });

  const request = (id: string, token: string | null = "secret") => (worker as { fetch: typeof fetch }).fetch(
    new Request(`http://localhost/api/sectors/focus-narratives/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    { DB: storage.db, ADMIN_SECRET: "secret" } as Env as never,
  );

  const snapshot = async () => {
    const results = await storage.db.batch<Record<string, unknown>>(tables.map((table) => storage.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`)));
    return Object.fromEntries(tables.map((table, index) => [table, results[index].results]));
  };

  it("deletes only the requested entry despite another entry's stale membership, and persists across GET", async () => {
    const before = await snapshot();
    const response = await request("focus-delete");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, id: "focus-delete" });

    const after = await snapshot();
    expect(after.sector_focus_narratives).toEqual(before.sector_focus_narratives.filter((row) => row.id !== "focus-delete"));
    expect(after.sector_focus_narrative_symbols).toEqual(before.sector_focus_narrative_symbols.filter((row) => row.focus_narrative_id !== "focus-delete"));
    for (const table of protectedTables) expect(after[table]).toEqual(before[table]);

    const refreshed = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/sectors/focus-narratives"), { DB: storage.db } as Env as never,
    );
    const body = await refreshed.json() as { rows: Array<{ id: string; sortOrder: number; selectedTickers: Array<{ ticker: string }> }> };
    expect(body.rows.map((row) => [row.id, row.sortOrder])).toEqual([["focus-stale", 0], ["focus-later", 9]]);
    expect(body.rows[0].selectedTickers.map((row) => row.ticker)).toEqual(["VRT", "NVDA"]);
    expect((await storage.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it.each(["stale membership", "missing narrative", "inactive peer group"])("can delete an entry with %s", async (scenario) => {
    if (scenario === "missing narrative") {
      storage.script("UPDATE sector_focus_narratives SET source_narrative_name = 'Removed source' WHERE id = 'focus-stale';");
    } else if (scenario === "inactive peer group") {
      storage.script("UPDATE sector_focus_narratives SET source_peer_group_id = 'pg-semis' WHERE id = 'focus-stale'; UPDATE peer_groups SET is_active = 0;");
    }
    expect((await request("focus-stale")).status).toBe(200);
    expect((await storage.db.prepare("SELECT id FROM sector_focus_narratives ORDER BY sort_order").all()).results)
      .toEqual([{ id: "focus-delete" }, { id: "focus-later" }]);
    expect((await storage.db.prepare("SELECT ticker FROM sector_focus_narrative_symbols WHERE focus_narrative_id = 'focus-stale'").all()).results).toEqual([]);
  });

  it("can delete the final entry without deleting shared symbols or sources", async () => {
    const before = await snapshot();
    for (const id of ["focus-stale", "focus-delete", "focus-later"]) expect((await request(id)).status).toBe(200);
    const after = await snapshot();
    expect(after.sector_focus_narratives).toEqual([]);
    expect(after.sector_focus_narrative_symbols).toEqual([]);
    for (const table of protectedTables) expect(after[table]).toEqual(before[table]);
  });

  it.each(["missing", "focus-delete' OR 1=1 --"])("returns 404 without changing data for unknown ID %s", async (id) => {
    const before = await snapshot();
    const response = await request(id);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Focus narrative not found." });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects an empty ID without changing data", async () => {
    const before = await snapshot();
    expect((await request(" ")).status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it.each([null, "wrong-secret"])("requires admin authorization (%s)", async (token) => {
    const before = await snapshot();
    const response = await request("focus-delete", token);
    expect(response.status).toBe(401);
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back ticker-link deletion if deleting the parent fails", async () => {
    storage.script(`CREATE TRIGGER prevent_focus_delete BEFORE DELETE ON sector_focus_narratives
      WHEN OLD.id = 'focus-delete' BEGIN SELECT RAISE(ABORT, 'simulated delete failure'); END;`);
    const before = await snapshot();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await request("focus-delete")).status).toBe(500);
    expect(await snapshot()).toEqual(before);
  });

  it("keeps source-membership validation unchanged for shared PUT saves", async () => {
    const before = await snapshot();
    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/sectors/focus-narratives", {
        method: "PUT",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({ focusNarratives: [{
          id: "focus-stale",
          sectorName: "AI Infrastructure",
          sourceNarrativeName: "AI Infrastructure",
          sourcePeerGroupId: null,
          manualName: null,
          selectedTickers: ["VRT", "NVDA"],
          comment: "Changed comment",
        }] }),
      }),
      { DB: storage.db, ADMIN_SECRET: "secret" } as Env as never,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Entry name is required when selected tickers mix sources or fall outside the selected narrative or peer group.",
    });
    expect(await snapshot()).toEqual(before);
  });
});
