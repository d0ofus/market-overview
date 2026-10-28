import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { createFocusNarrative } from "../src/sector-focus-narratives-service";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

type FocusRow = Awaited<ReturnType<typeof createFocusNarrative>>;

const genomicsTickers = ["ABSI", "ADPT", "CAI", "CDNA", "GH", "LLY", "NRIX", "NTRA", "TWST", "VCYT"];
const genomics = {
  sectorName: "Genomics",
  sourceNarrativeName: null,
  sourcePeerGroupId: "pg-genomics",
  manualName: "Genomics",
  selectedTickers: genomicsTickers,
  comment: "Genomics",
};

describe("targeted Focus Now creation against migrated SQLite", () => {
  let storage: ReturnType<typeof createSqliteD1>;
  const tables = ["sector_focus_narratives", "sector_focus_narrative_symbols", "symbols", "peer_groups", "ticker_peer_groups", "sector_tracker_entries", "sector_tracker_entry_symbols"];

  beforeEach(() => {
    storage = createSqliteD1();
    storage.script(`
      CREATE TABLE symbols (ticker TEXT PRIMARY KEY, name TEXT, asset_class TEXT);
      CREATE TABLE peer_groups (id TEXT PRIMARY KEY, name TEXT, is_active INTEGER);
      CREATE TABLE ticker_peer_groups (peer_group_id TEXT REFERENCES peer_groups(id), ticker TEXT REFERENCES symbols(ticker));
      CREATE TABLE sector_tracker_entries (id TEXT PRIMARY KEY, sector_name TEXT);
      CREATE TABLE sector_tracker_entry_symbols (entry_id TEXT REFERENCES sector_tracker_entries(id), ticker TEXT REFERENCES symbols(ticker));
      ${readFileSync("migrations/0053_sector_focus_narratives.sql", "utf8")}
      ${readFileSync("migrations/0065_sector_focus_narrative_comments.sql", "utf8")}
      ${readFileSync("migrations/0090_sector_focus_selected_tickers.sql", "utf8")}
      INSERT INTO symbols VALUES ('NVDA', 'NVIDIA', 'stock'), ('VRT', 'Vertiv', 'equity'), ('AMD', 'AMD', 'stock'), ('NEE', 'NextEra', 'stock');
      INSERT INTO symbols (ticker, name, asset_class)
        SELECT value, CASE WHEN value = 'LLY' THEN 'Eli Lilly & Co.' ELSE value END, 'stock'
        FROM json_each('${JSON.stringify(genomicsTickers)}');
      INSERT INTO peer_groups VALUES ('pg-genomics', 'Genomics', 1), ('pg-inactive', 'Old peer group', 0);
      INSERT INTO ticker_peer_groups SELECT 'pg-genomics', value FROM json_each('${JSON.stringify(genomicsTickers)}');
      INSERT INTO ticker_peer_groups VALUES ('pg-inactive', 'AMD');
      INSERT INTO sector_tracker_entries VALUES ('source-ai', 'AI Infrastructure'), ('source-bio', 'Biotechnology');
      INSERT INTO sector_tracker_entry_symbols VALUES ('source-ai', 'NVDA'), ('source-bio', 'ABSI'), ('source-bio', 'ADPT');
      INSERT INTO sector_focus_narratives
        (id, sector_name, sort_order, comment_text, source_narrative_name, source_peer_group_id, manual_name, created_at, updated_at)
      VALUES
        ('focus-stale', 'AI Infrastructure', 0, 'Stale selection', 'AI Infrastructure', NULL, NULL, '2026-07-17 00:00:00', '2026-07-18 00:00:00'),
        ('focus-missing', 'Removed narrative', 3, 'Keep missing source', 'Removed narrative', NULL, NULL, '2026-07-19 00:00:00', '2026-07-20 00:00:00'),
        ('focus-inactive', 'Old peer group', 9, 'Keep inactive source', NULL, 'pg-inactive', NULL, '2026-07-21 00:00:00', '2026-07-22 00:00:00');
      INSERT INTO sector_focus_narrative_symbols (focus_narrative_id, ticker, sort_order)
      VALUES ('focus-stale', 'VRT', 0), ('focus-stale', 'NVDA', 1), ('focus-missing', 'NEE', 0), ('focus-inactive', 'AMD', 0);
    `);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    storage.dispose();
  });

  const request = (method: string, path: string, body?: unknown, token: string | null = "secret") => (worker as { fetch: typeof fetch }).fetch(
    new Request(`http://localhost/api/sectors/focus-narratives${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { DB: storage.db, ADMIN_SECRET: "secret" } as Env as never,
  );
  const create = (body: unknown = genomics, token: string | null = "secret") => request("POST", "", body, token);
  const snapshot = async () => {
    const results = await storage.db.batch<Record<string, unknown>>(tables.map((table) => storage.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`)));
    return Object.fromEntries(tables.map((table, index) => [table, results[index].results]));
  };
  const custom = (manualName = "Custom", selectedTickers = ["NEW"]) => ({
    ...genomics, sectorName: manualName, sourcePeerGroupId: null, manualName, selectedTickers,
  });

  it("creates the screenshot's exact selection despite all three stale-source scenarios, preserving existing data", async () => {
    const before = await snapshot();
    const response = await create();
    expect(response.status).toBe(201);
    const { row } = await response.json() as { row: FocusRow };
    expect(row).toMatchObject({ ...genomics, sourcePeerGroupName: "Genomics", sortOrder: 10, selectedTickers: genomicsTickers.map((ticker) => ({
      ticker, name: ticker === "LLY" ? "Eli Lilly & Co." : ticker,
    })) });
    expect(row.id).toBeTruthy();
    expect(row.createdAt).toBeTruthy();
    expect(row.updatedAt).toBeTruthy();
    const after = await snapshot();
    expect(after.sector_focus_narratives.filter((item) => item.id !== row.id)).toEqual(before.sector_focus_narratives);
    expect(after.sector_focus_narrative_symbols.filter((item) => item.focus_narrative_id !== row.id)).toEqual(before.sector_focus_narrative_symbols);
    for (const table of tables.slice(2)) expect(after[table]).toEqual(before[table]);
    const refreshed = await request("GET", "");
    const body = await refreshed.json() as { rows: FocusRow[] };
    expect(body.rows.map((item) => item.id)).toEqual(["focus-stale", "focus-missing", "focus-inactive", row.id]);
    expect(body.rows.at(-1)).toEqual(row);
    expect((await storage.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("starts an empty list at zero and assigns its own ID", async () => {
    storage.script("DELETE FROM sector_focus_narrative_symbols; DELETE FROM sector_focus_narratives;");
    const response = await create({ ...custom(), id: "caller-supplied" });
    expect(response.status).toBe(201);
    const { row } = await response.json() as { row: FocusRow };
    expect(row.sortOrder).toBe(0);
    expect(row.id).not.toBe("caller-supplied");
  });

  it.each([
    { name: "peer subset", payload: { ...genomics, manualName: null }, expected: "Genomics" },
    { name: "narrative subset", payload: { ...custom(), sourceNarrativeName: "AI Infrastructure", manualName: null, selectedTickers: ["NVDA"] }, expected: "AI Infrastructure" },
    { name: "overlapping sources", payload: { ...genomics, sourceNarrativeName: "Biotechnology", selectedTickers: ["ABSI", "ADPT"], manualName: "Ignored" }, expected: "Genomics" },
    { name: "mixed sources", payload: { ...genomics, sourceNarrativeName: "AI Infrastructure", selectedTickers: ["NVDA", "ABSI"], manualName: "Mixed" }, expected: "Mixed" },
    { name: "outside source", payload: { ...genomics, selectedTickers: ["TSLA"], manualName: "Outside" }, expected: "Outside" },
    { name: "manual only", payload: custom("Manual only", [" brk.b ", "BRK.B", "VRT"]), expected: "Manual only" },
  ])("preserves naming and selection rules for $name", async ({ payload, expected }) => {
    // The matching narrative name already exists on a stale entry; remove it
    // only for this naming test so it tests precedence rather than duplicates.
    if (expected === "AI Infrastructure") expect((await request("DELETE", "/focus-stale")).status).toBe(200);
    const response = await create(payload);
    expect(response.status).toBe(201);
    const { row } = await response.json() as { row: FocusRow };
    expect(row.sectorName).toBe(expected);
    if (expected === "Manual only") expect(row.selectedTickers).toEqual([
      { ticker: "BRK.B", name: "BRK.B" }, { ticker: "VRT", name: "Vertiv" },
    ]);
  });

  it.each([null, "", "   "])("requires a manual name for mixed selections (%s) without changing data", async (manualName) => {
    const before = await snapshot();
    const response = await create({ ...genomics, sourceNarrativeName: "AI Infrastructure", selectedTickers: ["NVDA", "ABSI"], manualName });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Entry name is required when selected tickers mix sources or fall outside the selected narrative or peer group." });
    expect(await snapshot()).toEqual(before);
  });

  it.each([{ selectedTickers: [] }, { selectedTickers: ["invalid/ticker"] }])("rejects an empty normalized selection $selectedTickers without changing data", async ({ selectedTickers }) => {
    const before = await snapshot();
    const response = await create({ ...genomics, selectedTickers });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "At least one ticker must be selected." });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    { sourceNarrativeName: "Missing", sourcePeerGroupId: null },
    { sourceNarrativeName: null, sourcePeerGroupId: "Missing" },
    { sourceNarrativeName: null, sourcePeerGroupId: "pg-inactive" },
  ])("validates the new entry's own sources %j", async (sources) => {
    const before = await snapshot();
    expect((await create({ ...genomics, ...sources })).status).toBe(404);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["AI Infrastructure", "ai infrastructure"])("rejects duplicate name %s without changing data", async (manualName) => {
    const before = await snapshot();
    const response = await create(custom(manualName));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: `Focus Now already contains an entry named ${manualName}.` });
    expect(await snapshot()).toEqual(before);
  });

  it.each([null, "wrong-secret"])("requires admin authorization (%s)", async (token) => {
    const before = await snapshot();
    expect((await create(genomics, token)).status).toBe(401);
    expect(await snapshot()).toEqual(before);
  });

  it.each([null, [], { ...genomics, selectedTickers: "ABSI" }, { ...genomics, selectedTickers: [42] }])("rejects malformed payload %j", async (body) => {
    const before = await snapshot();
    expect((await create(body)).status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects malformed JSON without writes", async () => {
    const before = await snapshot();
    const response = await (worker as { fetch: typeof fetch }).fetch(new Request("http://localhost/api/sectors/focus-narratives", {
      method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: "{",
    }), { DB: storage.db, ADMIN_SECRET: "secret" } as Env as never);
    expect(response.status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back parent, missing symbol, and ticker links together on failure", async () => {
    storage.script(`CREATE TRIGGER prevent_focus_link BEFORE INSERT ON sector_focus_narrative_symbols
      WHEN NEW.ticker = 'NEW' BEGIN SELECT RAISE(ABORT, 'simulated creation failure'); END;`);
    const before = await snapshot();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await create(custom())).status).toBe(500);
    expect(await snapshot()).toEqual(before);
  });

  it("guards duplicate names during concurrent creates without adding the losing request's symbols", async () => {
    const responses = await Promise.all([create(custom("New idea", ["FIRST"])), create(custom("new idea", ["SECOND"]))]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const created = await responses.find((response) => response.status === 201)!.json() as { row: FocusRow };
    const added = await storage.db.prepare("SELECT ticker FROM symbols WHERE ticker IN ('FIRST', 'SECOND')").all();
    expect(added.results).toEqual([{ ticker: created.row.selectedTickers[0].ticker }]);
  });

  it("allocates distinct append positions for concurrent entries", async () => {
    const responses = await Promise.all([create(custom("First")), create(custom("Second"))]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const rows = await Promise.all(responses.map(async (response) => (await response.json() as { row: FocusRow }).row));
    expect(rows.map((row) => row.sortOrder).sort((a, b) => a - b)).toEqual([10, 11]);
  });

  it("keeps created entries compatible with GET, bulk edits/comments/reordering, and targeted deletion", async () => {
    const { row } = await (await create()).json() as { row: FocusRow };
    for (const id of ["focus-stale", "focus-missing", "focus-inactive"]) expect((await request("DELETE", `/${id}`)).status).toBe(200);
    const { row: second } = await (await create(custom())).json() as { row: FocusRow };
    const update = (item: FocusRow) => ({ ...item, selectedTickers: item.selectedTickers.map((ticker) => ticker.ticker) });
    const edited = { ...update(row), selectedTickers: ["LLY", "ABSI"], comment: "Updated comment" };
    const response = await request("PUT", "", { focusNarratives: [update(second), edited] });
    expect(response.status).toBe(200);
    const { rows } = await (await request("GET", "")).json() as { rows: FocusRow[] };
    expect(rows.map((item) => [item.id, item.sortOrder])).toEqual([[second.id, 0], [row.id, 1]]);
    expect(rows[1].comment).toBe("Updated comment");
    expect(rows[1].selectedTickers.map((item) => item.ticker)).toEqual(["LLY", "ABSI"]);
    expect((await request("DELETE", `/${row.id}`)).status).toBe(200);
    const remaining = await (await request("GET", "")).json() as { rows: FocusRow[] };
    expect(remaining.rows).toEqual([rows[0]]);
  });
});
