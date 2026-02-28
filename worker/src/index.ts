import { Hono } from "hono";
import { cors } from "hono/cors";
import { computeAndStoreSnapshot, loadSnapshot } from "./eod";
import type { Env } from "./types";
import { configPatchSchema, groupPatchSchema, itemCreateSchema } from "./validation";
import { loadConfig, upsertAudit } from "./db";
import { getProvider } from "./provider";
import { resolveTickerMeta } from "./symbol-resolver";
import { fetchSec13fSnapshot, MANAGER_DEFS } from "./sec13f";

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", cors());

const isAuthed = (req: Request, env: Env): boolean => {
  const secret = env.ADMIN_SECRET;
  if (!secret) return true;
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  return auth.slice(7) === secret;
};

async function refreshSnapshotSafe(env: Env): Promise<void> {
  try {
    await computeAndStoreSnapshot(env, undefined, "default");
  } catch (error) {
    console.error("snapshot refresh failed after admin mutation", error);
  }
}

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/status", async (c) => {
  const config = await c.env.DB.prepare(
    "SELECT id, name, timezone, eod_run_time_label as eodRunTimeLabel FROM dashboard_configs WHERE is_default = 1 LIMIT 1",
  ).first<{ id: string; name: string; timezone: string; eodRunTimeLabel: string }>();
  const latest = await c.env.DB.prepare(
    "SELECT as_of_date as asOfDate, generated_at as generatedAt, provider_label as providerLabel FROM snapshots_meta WHERE config_id = ? ORDER BY as_of_date DESC, generated_at DESC LIMIT 1",
  )
    .bind(config?.id ?? "default")
    .first<{ asOfDate?: string; generatedAt?: string; providerLabel?: string; as_of_date?: string; generated_at?: string; provider_label?: string }>();

  const normalizedLastUpdated = latest?.generatedAt ?? latest?.generated_at ?? null;
  const normalizedAsOf = latest?.asOfDate ?? latest?.as_of_date ?? null;
  const normalizedProvider = latest?.providerLabel ?? latest?.provider_label ?? null;

  return c.json({
    configId: config?.id ?? "default",
    timezone: config?.timezone ?? c.env.APP_TIMEZONE ?? "Australia/Melbourne",
    autoRefreshLabel: config?.eodRunTimeLabel ?? "22:15 ET",
    lastUpdated: normalizedLastUpdated,
    asOfDate: normalizedAsOf,
    providerLabel: normalizedProvider ?? "Alpaca (IEX Delayed Daily Bars)",
    dataProvider: c.env.DATA_PROVIDER ?? "alpaca",
  });
});

app.get("/api/dashboard", async (c) => {
  const configId = c.req.query("configId") ?? "default";
  const date = c.req.query("date");
  const data = await loadSnapshot(c.env, configId, date);
  c.header("Cache-Control", "public, max-age=300");
  return c.json(data);
});

app.get("/api/breadth", async (c) => {
  const universeId = c.req.query("universeId") ?? "sp500-lite";
  const limit = Number(c.req.query("limit") ?? 60);
  const rows = await c.env.DB.prepare(
    "SELECT as_of_date as asOfDate, universe_id as universeId, advancers, decliners, unchanged, pct_above_20ma as pctAbove20MA, pct_above_50ma as pctAbove50MA, pct_above_200ma as pctAbove200MA, new_20d_highs as new20DHighs, new_20d_lows as new20DLows, median_return_1d as medianReturn1D, median_return_5d as medianReturn5D, sentiment_json as sentimentJson FROM breadth_snapshots WHERE universe_id = ? ORDER BY as_of_date DESC LIMIT ?",
  )
    .bind(universeId, limit)
    .all();
  return c.json({ universeId, rows: (rows.results ?? []).reverse() });
});

app.get("/api/13f/overview", async (c) => {
  try {
    const snapshots = (await Promise.all(MANAGER_DEFS.map((m) => fetchSec13fSnapshot(m)))).filter(Boolean);
    if (snapshots.length > 0) {
      const topHoldings = snapshots
        .flatMap((s) =>
          s!.holdings.slice(0, 20).map((h) => ({
            managerId: s!.id,
            managerName: s!.name,
            ticker: h.ticker,
            issuerName: h.issuerName,
            valueUsd: h.valueUsd,
            weightPct: h.weightPct,
            cusip: h.cusip,
            reportQuarter: s!.reportQuarter,
          })),
        )
        .sort((a, b) => b.valueUsd - a.valueUsd)
        .slice(0, 40);
      const managers = snapshots.map((s) => ({
        id: s!.id,
        name: s!.name,
        cik: s!.cik,
        reportQuarter: s!.reportQuarter,
        filedDate: s!.filedDate,
        totalValueUsd: s!.totalValueUsd,
        totalHoldingsCount: s!.totalHoldingsCount,
      }));
      return c.json({ source: "sec-live", managers, topHoldings });
    }
  } catch (error) {
    console.error("13f sec-live overview failed", error);
  }
  const managers = await c.env.DB.prepare(
    "SELECT m.id, m.name, m.cik, m.aum_usd as aumUsd, r.report_quarter as reportQuarter, r.filed_date as filedDate, r.total_value_usd as totalValueUsd, r.total_holdings_count as totalHoldingsCount FROM filings_13f_managers m LEFT JOIN filings_13f_reports r ON r.id = (SELECT id FROM filings_13f_reports rr WHERE rr.manager_id = m.id ORDER BY rr.report_quarter DESC LIMIT 1) ORDER BY m.aum_usd DESC",
  ).all();
  const topHoldings = await c.env.DB.prepare(
    "SELECT h.report_id as reportId, h.ticker, h.issuer_name as issuerName, h.value_usd as valueUsd, h.weight_pct as weightPct FROM filings_13f_holdings h WHERE h.report_id IN (SELECT id FROM filings_13f_reports WHERE report_quarter = (SELECT MAX(report_quarter) FROM filings_13f_reports)) ORDER BY h.value_usd DESC LIMIT 25",
  ).all();
  return c.json({ source: "seed-fallback", managers: managers.results ?? [], topHoldings: topHoldings.results ?? [] });
});

app.get("/api/13f/manager/:id", async (c) => {
  const id = c.req.param("id");
  const managerDef = MANAGER_DEFS.find((m) => m.id === id);
  if (managerDef) {
    try {
      const snapshot = await fetchSec13fSnapshot(managerDef);
      if (snapshot) {
        return c.json({
          source: "sec-live",
          manager: { id: snapshot.id, name: snapshot.name, cik: snapshot.cik },
          reports: [
            {
              id: `${snapshot.id}:${snapshot.reportQuarter}`,
              reportQuarter: snapshot.reportQuarter,
              filedDate: snapshot.filedDate,
              totalValueUsd: snapshot.totalValueUsd,
              totalHoldingsCount: snapshot.totalHoldingsCount,
            },
          ],
          latestHoldings: snapshot.holdings.slice(0, 80),
        });
      }
    } catch (error) {
      console.error("13f sec-live manager failed", error);
    }
  }
  const manager = await c.env.DB.prepare("SELECT id, name, cik, aum_usd as aumUsd FROM filings_13f_managers WHERE id = ?")
    .bind(id)
    .first();
  if (!manager) return c.json({ error: "Manager not found" }, 404);
  const reports = await c.env.DB.prepare(
    "SELECT id, report_quarter as reportQuarter, filed_date as filedDate, total_value_usd as totalValueUsd, total_holdings_count as totalHoldingsCount FROM filings_13f_reports WHERE manager_id = ? ORDER BY report_quarter DESC",
  )
    .bind(id)
    .all();
  const latestReport = (reports.results ?? [])[0];
  const holdings = latestReport
    ? await c.env.DB.prepare(
        "SELECT ticker, issuer_name as issuerName, value_usd as valueUsd, shares, weight_pct as weightPct FROM filings_13f_holdings WHERE report_id = ? ORDER BY value_usd DESC LIMIT 50",
      )
        .bind((latestReport as { id: string }).id)
        .all()
    : { results: [] };
  return c.json({ manager, reports: reports.results ?? [], latestHoldings: holdings.results ?? [] });
});

app.get("/api/sectors/trending", async (c) => {
  const days = Math.max(5, Math.min(90, Number(c.req.query("days") ?? 30)));
  const rows = await c.env.DB.prepare(
    "SELECT s.sector, d.ticker, d.date, d.c FROM daily_bars d JOIN symbols s ON s.ticker = d.ticker WHERE s.sector IS NOT NULL AND d.date >= date('now', ?) ORDER BY s.sector, d.ticker, d.date",
  )
    .bind(`-${days + 7} day`)
    .all<{ sector: string; ticker: string; date: string; c: number }>();

  const bySector = new Map<string, Map<string, number[]>>();
  for (const r of rows.results ?? []) {
    const sectorMap = bySector.get(r.sector) ?? new Map<string, number[]>();
    const arr = sectorMap.get(r.ticker) ?? [];
    arr.push(r.c);
    sectorMap.set(r.ticker, arr);
    bySector.set(r.sector, sectorMap);
  }

  const out = [...bySector.entries()].map(([sector, tickers]) => {
    const returns = [...tickers.values()]
      .filter((v) => v.length > 6)
      .map((v) => ((v[v.length - 1] - v[v.length - 6]) / v[v.length - 6]) * 100);
    const score = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    return { sector, trend5d: score, symbolCount: tickers.size };
  });
  out.sort((a, b) => b.trend5d - a.trend5d);
  return c.json({ days, sectors: out });
});

app.get("/api/sectors/narratives", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, title, description, created_at as createdAt FROM sector_narratives ORDER BY created_at DESC").all();
  return c.json({ rows: rows.results ?? [] });
});

app.post("/api/sectors/narratives", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json()) as { title: string; description?: string };
  if (!body.title?.trim()) return c.json({ error: "title is required" }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO sector_narratives (id, title, description) VALUES (?, ?, ?)")
    .bind(id, body.title.trim(), body.description ?? null)
    .run();
  return c.json({ ok: true, id });
});

app.get("/api/sectors/symbol-options", async (c) => {
  const sector = c.req.query("sector");
  const rows = sector
    ? await c.env.DB.prepare(
        "SELECT ticker, name, sector, industry FROM symbols WHERE sector = ? ORDER BY ticker LIMIT 100",
      )
        .bind(sector)
        .all()
    : await c.env.DB.prepare(
        "SELECT ticker, name, sector, industry FROM symbols ORDER BY ticker LIMIT 200",
      ).all();
  return c.json({ rows: rows.results ?? [] });
});

app.get("/api/sectors/entries", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT e.id, e.sector_name as sectorName, e.event_date as eventDate, e.trend_score as trendScore, e.notes, e.narrative_id as narrativeId, n.title as narrativeTitle FROM sector_tracker_entries e LEFT JOIN sector_narratives n ON n.id = e.narrative_id ORDER BY e.event_date DESC",
  ).all();
  const links = await c.env.DB.prepare(
    "SELECT es.entry_id as entryId, es.ticker, s.name FROM sector_tracker_entry_symbols es LEFT JOIN symbols s ON s.ticker = es.ticker ORDER BY es.ticker",
  ).all<{ entryId: string; ticker: string; name: string | null }>();
  const map = new Map<string, Array<{ ticker: string; name: string | null }>>();
  for (const l of links.results ?? []) {
    const arr = map.get(l.entryId) ?? [];
    arr.push({ ticker: l.ticker, name: l.name });
    map.set(l.entryId, arr);
  }
  return c.json({
    rows: (rows.results ?? []).map((r: any) => ({
      ...r,
      symbols: map.get(r.id) ?? [],
    })),
  });
});

app.get("/api/sectors/calendar", async (c) => {
  const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
  const rows = await c.env.DB.prepare(
    "SELECT id, sector_name as sectorName, event_date as eventDate, trend_score as trendScore, notes FROM sector_tracker_entries WHERE substr(event_date, 1, 7) = ? ORDER BY event_date ASC",
  )
    .bind(month)
    .all();
  return c.json({ month, rows: rows.results ?? [] });
});

app.post("/api/sectors/entries", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json()) as {
    sectorName: string;
    eventDate: string;
    trendScore?: number;
    notes?: string;
    narrativeId?: string | null;
    symbols?: string[];
  };
  if (!body.sectorName || !body.eventDate) return c.json({ error: "sectorName and eventDate are required" }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO sector_tracker_entries (id, sector_name, event_date, trend_score, notes, narrative_id) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, body.sectorName, body.eventDate, body.trendScore ?? 0, body.notes ?? null, body.narrativeId ?? null)
    .run();
  const symbols = Array.from(new Set((body.symbols ?? []).map((s) => s.toUpperCase())));
  if (symbols.length > 0) {
    const stmts = symbols.map((ticker) =>
      c.env.DB.prepare("INSERT OR IGNORE INTO sector_tracker_entry_symbols (entry_id, ticker) VALUES (?, ?)")
        .bind(id, ticker),
    );
    await c.env.DB.batch(stmts);
  }
  return c.json({ ok: true, id });
});

app.get("/api/ticker/:ticker", async (c) => {
  const ticker = c.req.param("ticker").toUpperCase();
  const symbol = await c.env.DB.prepare("SELECT ticker, name, exchange, asset_class as assetClass FROM symbols WHERE ticker = ?")
    .bind(ticker)
    .first();
  if (!symbol) return c.json({ error: "Ticker not found" }, 404);

  const bars = await c.env.DB.prepare("SELECT date, c FROM daily_bars WHERE ticker = ? ORDER BY date DESC LIMIT 120")
    .bind(ticker)
    .all<{ date: string; c: number }>();
  const asc = [...(bars.results ?? [])].reverse();
  return c.json({
    symbol,
    series: asc,
    tradingViewEnabled: (c.env.TRADINGVIEW_WIDGET_ENABLED ?? "true") === "true",
  });
});

app.get("/api/admin/config", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const configId = c.req.query("configId") ?? "default";
  const config = await loadConfig(c.env, configId);
  return c.json(config);
});

app.get("/api/admin/provider-check", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const ticker = (c.req.query("ticker") ?? "SPY").toUpperCase();
  const latestBar = await c.env.DB.prepare(
    "SELECT ticker, date, c FROM daily_bars WHERE ticker = ? ORDER BY date DESC LIMIT 1",
  )
    .bind(ticker)
    .first<{ ticker: string; date: string; c: number }>();
  let providerLabel = "unknown";
  let providerSampleCount = 0;
  let providerError: string | null = null;
  try {
    const provider = getProvider(c.env);
    providerLabel = provider.label;
    const end = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
    const sample = await provider.getDailyBars([ticker], start, end);
    providerSampleCount = sample.length;
  } catch (error) {
    providerError = error instanceof Error ? error.message : "Provider check failed";
  }
  const latestSnapshot = await c.env.DB.prepare(
    "SELECT as_of_date as asOfDate, generated_at as generatedAt, provider_label as providerLabel FROM snapshots_meta ORDER BY generated_at DESC LIMIT 1",
  ).first();
  return c.json({
    ticker,
    latestBar,
    latestSnapshot,
    providerLabel,
    providerSampleCount,
    providerError,
  });
});

app.post("/api/admin/run-eod", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const date = c.req.query("date");
  const configId = c.req.query("configId") ?? "default";
  const result = await computeAndStoreSnapshot(c.env, date, configId);
  return c.json({ ok: true, ...result });
});

app.patch("/api/admin/config", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const payload = configPatchSchema.parse(await c.req.json());
  await c.env.DB.prepare(
    "UPDATE dashboard_configs SET name = ?, timezone = ?, eod_run_time_label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(payload.name, payload.timezone, payload.eodRunTimeLabel, payload.id)
    .run();
  await upsertAudit(c.env, payload.id, "CONFIG_PATCH", payload);
  await refreshSnapshotSafe(c.env);
  return c.json({ ok: true });
});

app.patch("/api/admin/group/:groupId", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const groupId = c.req.param("groupId");
  const payload = groupPatchSchema.parse(await c.req.json());
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE dashboard_groups SET title = ?, ranking_window_default = ?, show_sparkline = ?, pin_top10 = ? WHERE id = ?",
    ).bind(payload.title, payload.rankingWindowDefault, payload.showSparkline ? 1 : 0, payload.pinTop10 ? 1 : 0, groupId),
    c.env.DB.prepare("INSERT OR REPLACE INTO dashboard_columns (group_id, columns_json) VALUES (?, ?)")
      .bind(groupId, JSON.stringify(payload.columns)),
  ]);
  await upsertAudit(c.env, "default", "GROUP_PATCH", { groupId, payload });
  await refreshSnapshotSafe(c.env);
  return c.json({ ok: true });
});

app.post("/api/admin/group/:groupId/items", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const groupId = c.req.param("groupId");
  const payload = itemCreateSchema.parse(await c.req.json());
  const resolved = await resolveTickerMeta(payload.ticker, c.env);
  if (!resolved) return c.json({ error: `Ticker '${payload.ticker}' was not found in supported data sources.` }, 400);
  const orderRow = await c.env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextOrder FROM dashboard_items WHERE group_id = ?")
    .bind(groupId)
    .first<{ nextOrder: number }>();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR REPLACE INTO symbols (ticker, name, exchange, asset_class) VALUES (?, ?, ?, ?)",
    ).bind(resolved.ticker, resolved.name, resolved.exchange, resolved.assetClass),
    c.env.DB.prepare(
      "INSERT INTO dashboard_items (id, group_id, sort_order, ticker, display_name, enabled, tags_json) VALUES (?, ?, ?, ?, ?, 1, ?)",
    ).bind(
      crypto.randomUUID(),
      groupId,
      orderRow?.nextOrder ?? 1,
      resolved.ticker,
      payload.displayName ?? resolved.name,
      JSON.stringify(payload.tags),
    ),
  ]);
  await upsertAudit(c.env, "default", "ITEM_ADD", { groupId, payload });
  await refreshSnapshotSafe(c.env);
  return c.json({ ok: true });
});

app.post("/api/admin/section", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json()) as { configId?: string; title: string; description?: string };
  const configId = body.configId ?? "default";
  const order = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), 0) + 1 as nextOrder FROM dashboard_sections WHERE config_id = ?",
  )
    .bind(configId)
    .first<{ nextOrder: number }>();
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO dashboard_sections (id, config_id, sort_order, title, description, is_collapsible, default_collapsed) VALUES (?, ?, ?, ?, ?, 1, 0)",
  )
    .bind(id, configId, order?.nextOrder ?? 1, body.title, body.description ?? null)
    .run();
  await upsertAudit(c.env, configId, "SECTION_ADD", { id, ...body });
  await refreshSnapshotSafe(c.env);
  return c.json({ ok: true, id });
});

app.delete("/api/admin/section/:sectionId", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const sectionId = c.req.param("sectionId");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM dashboard_items WHERE group_id IN (SELECT id FROM dashboard_groups WHERE section_id = ?)").bind(sectionId),
    c.env.DB.prepare("DELETE FROM dashboard_columns WHERE group_id IN (SELECT id FROM dashboard_groups WHERE section_id = ?)").bind(sectionId),
    c.env.DB.prepare("DELETE FROM dashboard_groups WHERE section_id = ?").bind(sectionId),
    c.env.DB.prepare("DELETE FROM dashboard_sections WHERE id = ?").bind(sectionId),
  ]);
  await upsertAudit(c.env, "default", "SECTION_DELETE", { sectionId });
  await refreshSnapshotSafe(c.env);
  return c.json({ ok: true });
});

app.post("/api/admin/section/:sectionId/group", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const sectionId = c.req.param("sectionId");
  const body = (await c.req.json()) as { title: string; dataType?: string };
  const order = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), 0) + 1 as nextOrder FROM dashboard_groups WHERE section_id = ?",
  )
    .bind(sectionId)
    .first<{ nextOrder: number }>();
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO dashboard_groups (id, section_id, sort_order, title, data_type, ranking_window_default, show_sparkline, pin_top10) VALUES (?, ?, ?, ?, ?, '1W', 1, 0)",
    ).bind(id, sectionId, order?.nextOrder ?? 1, body.title, body.dataType ?? "custom"),
    c.env.DB.prepare("INSERT INTO dashboard_columns (group_id, columns_json) VALUES (?, ?)")
      .bind(id, JSON.stringify(["ticker", "name", "price", "1D", "1W", "YTD", "sparkline"])),
  ]);
  await upsertAudit(c.env, "default", "GROUP_ADD", { sectionId, id, ...body });
  await refreshSnapshotSafe(c.env);
  return c.json({ ok: true, id });
});

app.delete("/api/admin/group/:groupId", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const groupId = c.req.param("groupId");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM dashboard_items WHERE group_id = ?").bind(groupId),
    c.env.DB.prepare("DELETE FROM dashboard_columns WHERE group_id = ?").bind(groupId),
    c.env.DB.prepare("DELETE FROM dashboard_groups WHERE id = ?").bind(groupId),
  ]);
  await upsertAudit(c.env, "default", "GROUP_DELETE", { groupId });
  await refreshSnapshotSafe(c.env);
  return c.json({ ok: true });
});

app.delete("/api/admin/item/:itemId", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const itemId = c.req.param("itemId");
  await c.env.DB.prepare("DELETE FROM dashboard_items WHERE id = ?").bind(itemId).run();
  await upsertAudit(c.env, "default", "ITEM_DELETE", { itemId });
  await refreshSnapshotSafe(c.env);
  return c.json({ ok: true });
});

app.post("/api/admin/upload-bars", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json()) as { rows: Array<{ ticker: string; date: string; o: number; h: number; l: number; c: number; volume?: number }> };
  const rows = body.rows ?? [];
  if (rows.length === 0) return c.json({ ok: true, upserted: 0 });
  const statements = rows.map((r) =>
    c.env.DB.prepare(
      "INSERT OR REPLACE INTO daily_bars (ticker, date, o, h, l, c, volume) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(r.ticker.toUpperCase(), r.date, r.o, r.h, r.l, r.c, r.volume ?? 0),
  );
  await c.env.DB.batch(statements);
  await refreshSnapshotSafe(c.env);
  return c.json({ ok: true, upserted: rows.length });
});

app.post("/api/admin/reorder", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json()) as { type: "group" | "item"; orderedIds: string[] };
  const table = body.type === "group" ? "dashboard_groups" : "dashboard_items";
  const stmts = body.orderedIds.map((id, i) =>
    c.env.DB.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`).bind(i + 1, id),
  );
  if (stmts.length > 0) await c.env.DB.batch(stmts);
  await upsertAudit(c.env, "default", "REORDER", body);
  await refreshSnapshotSafe(c.env);
  return c.json({ ok: true });
});

app.get("/api/admin/audit", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const rows = await c.env.DB.prepare(
    "SELECT id, action, actor, payload_json as payloadJson, created_at as createdAt FROM config_audit ORDER BY created_at DESC LIMIT 50",
  ).all();
  return c.json({ rows: rows.results ?? [] });
});

export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledEvent, env: Env): Promise<void> => {
    await computeAndStoreSnapshot(env, undefined, "default");
  },
};
