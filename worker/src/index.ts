import { Hono } from "hono";
import { cors } from "hono/cors";
import { computeAndStoreSnapshot, loadSnapshot } from "./eod";
import type { Env } from "./types";
import { configPatchSchema, groupPatchSchema, itemCreateSchema } from "./validation";
import { loadConfig, upsertAudit } from "./db";

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", cors());

const isAuthed = (req: Request, env: Env): boolean => {
  const secret = env.ADMIN_SECRET;
  if (!secret) return true;
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  return auth.slice(7) === secret;
};

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/status", async (c) => {
  const config = await c.env.DB.prepare(
    "SELECT id, name, timezone, eod_run_time_label as eodRunTimeLabel FROM dashboard_configs WHERE is_default = 1 LIMIT 1",
  ).first<{ id: string; name: string; timezone: string; eodRunTimeLabel: string }>();
  const latest = await c.env.DB.prepare(
    "SELECT as_of_date as asOfDate, generated_at as generatedAt, provider_label as providerLabel FROM snapshots_meta WHERE config_id = ? ORDER BY as_of_date DESC LIMIT 1",
  )
    .bind(config?.id ?? "default")
    .first();

  return c.json({
    configId: config?.id ?? "default",
    timezone: config?.timezone ?? c.env.APP_TIMEZONE ?? "America/New_York",
    autoRefreshLabel: config?.eodRunTimeLabel ?? "22:15 ET",
    lastUpdated: latest?.generatedAt ?? null,
    asOfDate: latest?.asOfDate ?? null,
    providerLabel: latest?.providerLabel ?? "Synthetic Seeded EOD",
    dataProvider: c.env.DATA_PROVIDER ?? "synthetic",
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
  return c.json({ ok: true });
});

app.post("/api/admin/group/:groupId/items", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const groupId = c.req.param("groupId");
  const payload = itemCreateSchema.parse(await c.req.json());
  const orderRow = await c.env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextOrder FROM dashboard_items WHERE group_id = ?")
    .bind(groupId)
    .first<{ nextOrder: number }>();
  await c.env.DB.prepare(
    "INSERT INTO dashboard_items (id, group_id, sort_order, ticker, display_name, enabled, tags_json) VALUES (?, ?, ?, ?, ?, 1, ?)",
  )
    .bind(crypto.randomUUID(), groupId, orderRow?.nextOrder ?? 1, payload.ticker, payload.displayName ?? null, JSON.stringify(payload.tags))
    .run();
  await upsertAudit(c.env, "default", "ITEM_ADD", { groupId, payload });
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
      .bind(id, JSON.stringify(["ticker", "price", "1D", "1W", "YTD", "sparkline"])),
  ]);
  await upsertAudit(c.env, "default", "GROUP_ADD", { sectionId, id, ...body });
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
  return c.json({ ok: true });
});

app.delete("/api/admin/item/:itemId", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const itemId = c.req.param("itemId");
  await c.env.DB.prepare("DELETE FROM dashboard_items WHERE id = ?").bind(itemId).run();
  await upsertAudit(c.env, "default", "ITEM_DELETE", { itemId });
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
