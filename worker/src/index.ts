import { Hono } from "hono";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import { computeAndStoreSnapshot, loadSnapshot, recomputeBreadthFromStoredBars, recomputeDashboardFromStoredBars, refreshSp500CoreBreadth } from "./eod";
import type { Env } from "./types";
import {
  configPatchSchema,
  groupPatchSchema,
  itemCreateSchema,
  itemPatchSchema,
  scanPresetCreateSchema,
  scanPresetPatchSchema,
  scanRefreshSchema,
  peerBootstrapSchema,
  peerGroupCreateSchema,
  peerGroupPatchSchema,
  peerMembershipCreateSchema,
  peerNormalizeSchema,
  peerSeedSchema,
  watchlistSetCreateSchema,
  watchlistSetPatchSchema,
  watchlistSourceCreateSchema,
  watchlistSourcePatchSchema,
} from "./validation";
import { loadConfig, upsertAudit } from "./db";
import { getProvider } from "./provider";
import { resolveTickerMeta } from "./symbol-resolver";
import { fetchSec13fSnapshot, MANAGER_DEFS } from "./sec13f";
import { syncEtfConstituents } from "./etf";
import { EQUAL_WEIGHT_SECTOR_ETFS, ETF_CATALOG } from "./etf-catalog";
import { latestUsSessionAsOfDate, parseLocalTime, shouldRunScheduledEod } from "./refresh-timing";
import { normalizeEtfSyncStatusRow, type EtfSyncStatusRow } from "./etf-sync-status";
import {
  cleanupOldAlertsData,
  ingestTradingViewAlertEmailsBatch,
  queryAlertsByFilters,
  queryUniqueTickerDaysByFilters,
  reconcileAlertsFromMailboxAdapters,
} from "./alerts-service";
import type { InboundEmailPayload } from "./alerts-types";
import { handleInboundTradingViewEmail } from "./alerts-email";
import { fetchTickerNews } from "./alerts-news";
import {
  cleanupOldScanningData,
} from "./scanning-service";
import {
  cleanupOldGappersData,
  getGappersSnapshot,
  refreshGappersSnapshot,
} from "./gappers-service";
import {
  cleanupOldScansPageData,
  loadCompiledScansSnapshot,
  deleteScanPreset,
  listScanPresets,
  loadDefaultScanPreset,
  loadLatestScansSnapshot,
  loadScanPreset,
  refreshScansSnapshot,
  upsertScanPreset,
} from "./scans-page-service";
import { isOverviewSnapshotStale } from "./overview-snapshot";
import {
  createPeerGroup,
  deletePeerGroup,
  listPeerBootstrapCandidates,
  listPeerGroups,
  loadPeerTickerDetail,
  queryPeerDirectory,
  removeTickerPeerMembership,
  updatePeerGroup,
  upsertTickerPeerMembership,
} from "./peer-groups-service";
import { loadPeerMetrics } from "./peer-metrics-service";
import { normalizeSeededPeerGroupLabels, seedPeerGroupForTicker } from "./peer-seed-service";
import {
  compileActiveWatchlistSets,
  compileWatchlistSet,
  createWatchlistSet,
  createWatchlistSource,
  deleteWatchlistSet,
  deleteWatchlistSource,
  listWatchlistSetRuns,
  listWatchlistSets,
  loadWatchlistCompiledRows,
  loadWatchlistSet,
  loadWatchlistUniqueRows,
  resolveExportFileName,
  runDueWatchlistCompiles,
  tickersToSingleColumnCsv,
  tickersToTxt,
  updateWatchlistSet,
  updateWatchlistSource,
} from "./watchlist-compiler-service";

const app = new Hono<{ Bindings: Env }>();
const API_REVISION = "2026-03-07-alerts-email-ingestion";
const CATALOG_ENSURE_INTERVAL_MS = 5 * 60_000;
const OVERVIEW_BAR_REFRESH_INTERVAL_MS = 5 * 60_000;
const OVERVIEW_SPARKLINE_MIN_POINTS = 63;
const OVERVIEW_HISTORY_LOOKBACK_DAYS = 140;
const ALERTS_HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60_000;
const SCANNING_HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60_000;
const GAPPERS_HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60_000;
const SCANS_PAGE_HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60_000;
let lastEtfCatalogEnsureAt = 0;
let lastOverviewCatalogEnsureAt = 0;
let lastOverviewBarRefreshAt = 0;
let lastAlertsHousekeepingAt = 0;
let lastScanningHousekeepingAt = 0;
let lastGappersHousekeepingAt = 0;
let lastScansPageHousekeepingAt = 0;

app.use("/api/*", cors());

const isAuthed = (req: Request, env: Env): boolean => {
  const secret = env.ADMIN_SECRET;
  if (!secret) return true;
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  return auth.slice(7) === secret;
};

function readGappersLlmOverride(req: Request): {
  provider?: "openai" | "anthropic";
  apiKey?: string;
  model?: string;
  baseUrl?: string | null;
} | null {
  const providerRaw = req.headers.get("x-llm-provider")?.trim().toLowerCase();
  const provider = providerRaw === "openai" || providerRaw === "anthropic"
    ? providerRaw
    : undefined;
  const apiKey = req.headers.get("x-llm-api-key")?.trim() || undefined;
  const model = req.headers.get("x-llm-model")?.trim() || undefined;
  const baseUrl = req.headers.get("x-llm-base-url")?.trim() || undefined;
  if (!provider && !apiKey && !model && !baseUrl) return null;
  return { provider, apiKey, model, baseUrl: baseUrl ?? null };
}

function readGappersFilters(req: Request): {
  limit?: number;
  minMarketCap?: number | null;
  maxMarketCap?: number | null;
  industries?: string[];
  minPrice?: number | null;
  maxPrice?: number | null;
  minGapPct?: number | null;
  maxGapPct?: number | null;
} | null {
  const url = new URL(req.url);
  const toNumber = (key: string): number | null | undefined => {
    const raw = url.searchParams.get(key);
    if (raw == null || raw.trim() === "") return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const industriesRaw = url.searchParams.get("industries");
  const industries = industriesRaw
    ? industriesRaw.split(",").map((value) => value.trim()).filter(Boolean)
    : undefined;
  const filters = {
    limit: toNumber("limit") ?? undefined,
    minMarketCap: toNumber("minMarketCap"),
    maxMarketCap: toNumber("maxMarketCap"),
    industries,
    minPrice: toNumber("minPrice"),
    maxPrice: toNumber("maxPrice"),
    minGapPct: toNumber("minGapPct"),
    maxGapPct: toNumber("maxGapPct"),
  };
  return Object.values(filters).some((value) => value != null && (!(Array.isArray(value)) || value.length > 0))
    ? filters
    : null;
}

async function refreshSnapshotSafe(env: Env): Promise<void> {
  try {
    await computeAndStoreSnapshot(env, undefined, "default");
  } catch (error) {
    console.error("snapshot refresh failed after admin mutation", error);
  }
}

async function ensureBreadthRowsSafe(env: Env): Promise<void> {
  try {
    await computeAndStoreSnapshot(env, undefined, "default");
  } catch (error) {
    console.error("on-demand breadth backfill failed", error);
  }
}

const isStaleDate = (iso: string | null | undefined, maxAgeDays = 30): boolean => {
  if (!iso) return true;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return true;
  return Date.now() - then > maxAgeDays * 86400_000;
};

function uniqueTickers(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.toUpperCase()).filter(Boolean)));
}

const EQUAL_WEIGHT_US_INDEX_ETFS = [
  { ticker: "RSP", instrumentName: "Invesco S&P 500 Equal Weight ETF" },
  { ticker: "QQQE", instrumentName: "Direxion NASDAQ-100 Equal Weighted Index Shares" },
  { ticker: "EQAL", instrumentName: "Invesco Russell 1000 Equal Weight ETF" },
  { ticker: "EDOW", instrumentName: "First Trust Dow 30 Equal Weight ETF" },
] as const;

async function listEtfWatchlistRows(
  env: Env,
  listType: "sector" | "industry",
): Promise<Array<{ listType: string; parentSector: string | null; industry: string | null; ticker: string; fundName: string | null; sortOrder: number; sourceUrl: string | null }>> {
  const orderBy = listType === "sector"
    ? "sort_order ASC, ticker ASC"
    : "COALESCE(parent_sector, '') ASC, COALESCE(industry, '') ASC, sort_order ASC, ticker ASC";
  try {
    const rows = await env.DB.prepare(
      `SELECT list_type as listType, parent_sector as parentSector, industry, ticker, fund_name as fundName, sort_order as sortOrder, source_url as sourceUrl FROM etf_watchlists WHERE list_type = ? ORDER BY ${orderBy}`,
    )
      .bind(listType)
      .all<{ listType: string; parentSector: string | null; industry: string | null; ticker: string; fundName: string | null; sortOrder: number; sourceUrl: string | null }>();
    return rows.results ?? [];
  } catch {
    const rows = await env.DB.prepare(
      `SELECT list_type as listType, parent_sector as parentSector, industry, ticker, fund_name as fundName, sort_order as sortOrder FROM etf_watchlists WHERE list_type = ? ORDER BY ${orderBy}`,
    )
      .bind(listType)
      .all<{ listType: string; parentSector: string | null; industry: string | null; ticker: string; fundName: string | null; sortOrder: number }>();
    return (rows.results ?? []).map((row) => ({ ...row, sourceUrl: null }));
  }
}

async function loadEtfSourceUrl(env: Env, ticker: string): Promise<string | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT source_url as sourceUrl FROM etf_watchlists WHERE ticker = ? ORDER BY list_type ASC LIMIT 1",
    )
      .bind(ticker)
      .first<{ sourceUrl: string | null }>();
    return row?.sourceUrl?.trim() || null;
  } catch {
    return null;
  }
}

function catalogAssetClass(exactUrl: string): "etf" | "index" {
  const lower = exactUrl.toLowerCase();
  if (
    lower.includes("indexes.nasdaqomx.com") ||
    lower.includes("investing.com/indices/") ||
    lower.includes("finance.yahoo.com/quote/%5e") ||
    lower.includes("finance.yahoo.com/quote/^")
  ) {
    return "index";
  }
  return "etf";
}

async function ensureEtfCatalogCoverage(env: Env): Promise<void> {
  const now = Date.now();
  if (now - lastEtfCatalogEnsureAt < CATALOG_ENSURE_INTERVAL_MS) return;
  lastEtfCatalogEnsureAt = now;

  const statements = ETF_CATALOG.flatMap((entry, idx) => {
    const ticker = entry.ticker.toUpperCase();
    const defaultName = `${ticker} ${catalogAssetClass(entry.exactUrl) === "index" ? "Index" : "ETF"}`;
    return [
      env.DB.prepare(
        "INSERT OR IGNORE INTO symbols (ticker, name, exchange, asset_class, sector, industry) VALUES (?, ?, NULL, ?, ?, ?)",
      ).bind(ticker, defaultName, catalogAssetClass(entry.exactUrl), entry.sector, entry.industry),
      env.DB.prepare(
        "INSERT INTO etf_watchlists (list_type, parent_sector, industry, ticker, fund_name, sort_order) VALUES ('industry', ?, ?, ?, ?, ?) ON CONFLICT(list_type, ticker) DO UPDATE SET parent_sector = excluded.parent_sector, industry = excluded.industry, fund_name = CASE WHEN COALESCE(etf_watchlists.fund_name, '') = '' OR etf_watchlists.fund_name = etf_watchlists.ticker OR etf_watchlists.fund_name LIKE '% ETF' THEN excluded.fund_name ELSE etf_watchlists.fund_name END",
      ).bind(entry.sector, entry.industry, ticker, defaultName, 2000 + idx),
      env.DB.prepare(
        "INSERT OR IGNORE INTO etf_constituent_sync_status (etf_ticker, last_synced_at, status, error, source, records_count, updated_at) VALUES (?, NULL, 'pending', NULL, 'catalog:import', 0, CURRENT_TIMESTAMP)",
      ).bind(ticker),
    ];
  });
  if (statements.length > 0) await env.DB.batch(statements);
}

async function ensureOverviewCatalogCoverage(env: Env): Promise<void> {
  const now = Date.now();
  if (now - lastOverviewCatalogEnsureAt < CATALOG_ENSURE_INTERVAL_MS) return;
  lastOverviewCatalogEnsureAt = now;
  await ensureEtfCatalogCoverage(env);

  const equitiesSection = await env.DB.prepare(
    "SELECT id FROM dashboard_sections WHERE config_id = 'default' AND title LIKE '%Equities%' ORDER BY sort_order ASC LIMIT 1",
  ).first<{ id: string }>();
  const macroSection = await env.DB.prepare(
    "SELECT id FROM dashboard_sections WHERE config_id = 'default' AND title LIKE '%Macro%' ORDER BY sort_order ASC LIMIT 1",
  ).first<{ id: string }>();
  const usIndexGroup = macroSection
    ? await env.DB.prepare(
      "SELECT id, sort_order as sortOrder FROM dashboard_groups WHERE section_id = ? AND title = 'US Index Futures' LIMIT 1",
    ).bind(macroSection.id).first<{ id: string; sortOrder: number }>()
    : null;
  if (!equitiesSection?.id) return;
  const majorEtfGroup = await env.DB.prepare(
    "SELECT id, sort_order as sortOrder FROM dashboard_groups WHERE section_id = ? AND title = 'Major ETF Stats' LIMIT 1",
  ).bind(equitiesSection.id).first<{ id: string; sortOrder: number }>();
  let removedDuplicateMajorEtf = false;
  if (majorEtfGroup?.id) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM dashboard_items WHERE group_id = ?").bind(majorEtfGroup.id),
      env.DB.prepare("DELETE FROM dashboard_columns WHERE group_id = ?").bind(majorEtfGroup.id),
      env.DB.prepare("DELETE FROM dashboard_groups WHERE id = ?").bind(majorEtfGroup.id),
      env.DB.prepare(
        "UPDATE dashboard_groups SET sort_order = sort_order - 1 WHERE section_id = ? AND sort_order > ?",
      ).bind(equitiesSection.id, majorEtfGroup.sortOrder),
    ]);
    removedDuplicateMajorEtf = true;
  }
  const thematicGroup = await env.DB.prepare(
    "SELECT id, sort_order as sortOrder, title FROM dashboard_groups WHERE section_id = ? AND title IN ('Thematic ETFs', 'Industry/Thematic ETFs') ORDER BY CASE WHEN title = 'Industry/Thematic ETFs' THEN 0 ELSE 1 END, sort_order ASC LIMIT 1",
  ).bind(equitiesSection.id).first<{ id: string; sortOrder: number; title: string }>();
  const sectorGroup = await env.DB.prepare(
    "SELECT id, sort_order as sortOrder FROM dashboard_groups WHERE section_id = ? AND title = 'Sector ETFs' LIMIT 1",
  ).bind(equitiesSection.id).first<{ id: string; sortOrder: number }>();
  if (!thematicGroup?.id || !sectorGroup?.id) {
    if (removedDuplicateMajorEtf) {
      await recomputeDashboardFromStoredBars(env);
    }
    return;
  }

  const equalWeightGroupId = "g-sector-etf-eqwt";
  const usIndexEqualWeightGroupId = "g-us-index-eqwt";
  const equalWeightGroup = await env.DB.prepare(
    "SELECT id FROM dashboard_groups WHERE id = ? LIMIT 1",
  ).bind(equalWeightGroupId).first<{ id: string }>();
  const usIndexEqualWeightGroup = await env.DB.prepare(
    "SELECT id FROM dashboard_groups WHERE id = ? LIMIT 1",
  ).bind(usIndexEqualWeightGroupId).first<{ id: string }>();
  const industryWatchlistRows = await env.DB.prepare(
    "SELECT ticker, fund_name as fundName FROM etf_watchlists WHERE list_type = 'industry' ORDER BY COALESCE(parent_sector, '') ASC, COALESCE(industry, '') ASC, sort_order ASC, ticker ASC",
  ).all<{ ticker: string; fundName: string | null }>();
  const thematicSeedRows = (industryWatchlistRows.results ?? []).length > 0
    ? (industryWatchlistRows.results ?? [])
    : ETF_CATALOG.map((row) => ({ ticker: row.ticker, fundName: `${row.ticker.toUpperCase()} ${catalogAssetClass(row.exactUrl) === "index" ? "Index" : "ETF"}` }));
  const thematicTickers = thematicSeedRows.map((row) => row.ticker.toUpperCase()).filter(Boolean);
  const thematicNameByTicker = new Map(
    thematicSeedRows.map((row) => [row.ticker.toUpperCase(), (row.fundName ?? "").trim()]).filter((entry) => Boolean(entry[0])),
  );
  const equalWeightNameByTicker = new Map(EQUAL_WEIGHT_SECTOR_ETFS.map((row) => [row.ticker.toUpperCase(), row.instrumentName]));
  const equalWeightTickers = uniqueTickers(Array.from(equalWeightNameByTicker.keys()));
  const usIndexEqualWeightNameByTicker = new Map(EQUAL_WEIGHT_US_INDEX_ETFS.map((row) => [row.ticker.toUpperCase(), row.instrumentName]));
  const usIndexEqualWeightTickers = uniqueTickers(Array.from(usIndexEqualWeightNameByTicker.keys()));
  const allTickers = uniqueTickers([...thematicTickers, ...equalWeightTickers, ...usIndexEqualWeightTickers]);

  const existingThematicRows = await env.DB.prepare(
    "SELECT id, ticker, display_name as displayName, sort_order as sortOrder FROM dashboard_items WHERE group_id = ? ORDER BY sort_order ASC, ticker ASC",
  ).bind(thematicGroup.id).all<{ id: string; ticker: string; displayName: string | null; sortOrder: number }>();
  const existingThematic = existingThematicRows.results ?? [];
  const thematicNeedsRebuild =
    existingThematic.length !== thematicTickers.length ||
    thematicTickers.some((ticker, idx) => {
      const existing = existingThematic[idx];
      if (!existing) return true;
      const desiredName = thematicNameByTicker.get(ticker) || null;
      return existing.ticker.toUpperCase() !== ticker || (desiredName !== null && (existing.displayName ?? null) !== desiredName);
    });

  const existingEqRows = await env.DB.prepare(
    "SELECT ticker FROM dashboard_items WHERE group_id = ?",
  ).bind(equalWeightGroupId).all<{ ticker: string }>();
  const existingEq = new Set((existingEqRows.results ?? []).map((r) => r.ticker.toUpperCase()));
  const missingEq = equalWeightTickers.filter((ticker) => !existingEq.has(ticker));
  const existingUsIndexEqRows = await env.DB.prepare(
    "SELECT ticker FROM dashboard_items WHERE group_id = ?",
  ).bind(usIndexEqualWeightGroupId).all<{ ticker: string }>();
  const existingUsIndexEq = new Set((existingUsIndexEqRows.results ?? []).map((r) => r.ticker.toUpperCase()));
  const missingUsIndexEq = usIndexEqualWeightTickers.filter((ticker) => !existingUsIndexEq.has(ticker));

  const eqNameRows = await env.DB.prepare(
    `SELECT ticker, name FROM symbols WHERE ticker IN (${[...equalWeightTickers, ...usIndexEqualWeightTickers].map(() => "?").join(",")})`,
  )
    .bind(...equalWeightTickers, ...usIndexEqualWeightTickers)
    .all<{ ticker: string; name: string | null }>();
  const eqNameMap = new Map((eqNameRows.results ?? []).map((row) => [row.ticker.toUpperCase(), row.name ?? ""]));
  const needsEqNameFix = equalWeightTickers.some((ticker) => (eqNameMap.get(ticker) ?? "") !== (equalWeightNameByTicker.get(ticker) ?? ""));
  const needsUsIndexEqNameFix = usIndexEqualWeightTickers.some((ticker) => (eqNameMap.get(ticker) ?? "") !== (usIndexEqualWeightNameByTicker.get(ticker) ?? ""));

  const maxSortRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), 0) as maxSort FROM dashboard_groups WHERE section_id = ?",
  ).bind(equitiesSection.id).first<{ maxSort: number }>();
  const shouldMoveThematicDown = thematicGroup.sortOrder < (maxSortRow?.maxSort ?? thematicGroup.sortOrder);
  const needsThematicTitleUpdate = thematicGroup.title !== "Industry/Thematic ETFs";
  const needsStructureUpdate =
    removedDuplicateMajorEtf ||
    !equalWeightGroup ||
    shouldMoveThematicDown ||
    needsThematicTitleUpdate ||
    (Boolean(usIndexGroup?.id) && !usIndexEqualWeightGroup);
  const needsItemUpdate = thematicNeedsRebuild || missingEq.length > 0 || missingUsIndexEq.length > 0;
  const needsBarRefresh = needsItemUpdate || needsEqNameFix || needsUsIndexEqNameFix;
  const needsSnapshotRefresh = needsStructureUpdate || needsItemUpdate || needsEqNameFix || needsUsIndexEqNameFix;

  const structureStatements = [
    env.DB.prepare(
      "INSERT OR IGNORE INTO dashboard_groups (id, section_id, sort_order, title, data_type, ranking_window_default, show_sparkline, pin_top10) VALUES (?, ?, ?, 'Sector ETFs (Equal Weight)', 'equities', '1W', 1, 1)",
    ).bind(equalWeightGroupId, equitiesSection.id, sectorGroup.sortOrder + 1),
    env.DB.prepare(
      "INSERT OR IGNORE INTO dashboard_columns (group_id, columns_json) VALUES (?, COALESCE((SELECT columns_json FROM dashboard_columns WHERE group_id = 'g-sector-etf' LIMIT 1), '[\"ticker\",\"name\",\"price\",\"1D\",\"1W\",\"3M\",\"6M\",\"YTD\",\"sparkline\"]'))",
    ).bind(equalWeightGroupId),
  ];
  if (macroSection?.id && usIndexGroup?.id && !usIndexEqualWeightGroup) {
    structureStatements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO dashboard_groups (id, section_id, sort_order, title, data_type, ranking_window_default, show_sparkline, pin_top10) VALUES (?, ?, ?, 'US Index Futures (Equal Weight)', 'macro', '1W', 1, 1)",
      ).bind(usIndexEqualWeightGroupId, macroSection.id, usIndexGroup.sortOrder + 1),
      env.DB.prepare(
        "INSERT OR IGNORE INTO dashboard_columns (group_id, columns_json) VALUES (?, COALESCE((SELECT columns_json FROM dashboard_columns WHERE group_id = 'g-us-index' LIMIT 1), '[\"ticker\",\"name\",\"price\",\"1D\",\"1W\",\"5D\",\"YTD\",\"pctFrom52WHigh\",\"sparkline\"]'))",
      ).bind(usIndexEqualWeightGroupId),
      env.DB.prepare(
        "UPDATE dashboard_groups SET sort_order = sort_order + 1 WHERE section_id = ? AND sort_order > ? AND id <> ?",
      ).bind(macroSection.id, usIndexGroup.sortOrder, usIndexEqualWeightGroupId),
    );
  }
  if (shouldMoveThematicDown) {
    structureStatements.push(
      env.DB.prepare(
        "UPDATE dashboard_groups SET sort_order = (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM dashboard_groups WHERE section_id = ? AND id <> ?) WHERE id = ?",
      ).bind(equitiesSection.id, thematicGroup.id, thematicGroup.id),
    );
  }
  if (needsThematicTitleUpdate) {
    structureStatements.push(
      env.DB.prepare(
        "UPDATE dashboard_groups SET title = 'Industry/Thematic ETFs' WHERE id = ?",
      ).bind(thematicGroup.id),
    );
  }

  const eqBaseSortRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), 0) as maxSort FROM dashboard_items WHERE group_id = ?",
  ).bind(equalWeightGroupId).first<{ maxSort: number }>();
  const usIndexEqBaseSortRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), 0) as maxSort FROM dashboard_items WHERE group_id = ?",
  ).bind(usIndexEqualWeightGroupId).first<{ maxSort: number }>();
  const thematicItemStatements = thematicNeedsRebuild
    ? [
        env.DB.prepare("DELETE FROM dashboard_items WHERE group_id = ?").bind(thematicGroup.id),
        ...thematicTickers.map((ticker, idx) =>
          env.DB.prepare(
            "INSERT INTO dashboard_items (id, group_id, sort_order, ticker, display_name, enabled, tags_json, holdings_json) VALUES (?, ?, ?, ?, ?, 1, '[]', NULL)",
          ).bind(
            crypto.randomUUID(),
            thematicGroup.id,
            idx + 1,
            ticker,
            thematicNameByTicker.get(ticker) || null,
          ),
        ),
      ]
    : [];
  const equalWeightItemStatements = missingEq.map((ticker, idx) =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO dashboard_items (id, group_id, sort_order, ticker, display_name, enabled, tags_json, holdings_json) VALUES (?, ?, ?, ?, NULL, 1, '[]', NULL)",
    ).bind(crypto.randomUUID(), equalWeightGroupId, (eqBaseSortRow?.maxSort ?? 0) + idx + 1, ticker),
  );
  const usIndexEqualWeightItemStatements = missingUsIndexEq.map((ticker, idx) =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO dashboard_items (id, group_id, sort_order, ticker, display_name, enabled, tags_json, holdings_json) VALUES (?, ?, ?, ?, NULL, 1, '[]', NULL)",
    ).bind(crypto.randomUUID(), usIndexEqualWeightGroupId, (usIndexEqBaseSortRow?.maxSort ?? 0) + idx + 1, ticker),
  );
  const symbolStatements = allTickers.map((ticker) => {
    const preferredName = usIndexEqualWeightNameByTicker.get(ticker) ?? equalWeightNameByTicker.get(ticker) ?? thematicNameByTicker.get(ticker) ?? `${ticker} ETF`;
    const isEqualWeight = equalWeightNameByTicker.has(ticker) || usIndexEqualWeightNameByTicker.has(ticker) ? 1 : 0;
    return env.DB.prepare(
      "INSERT INTO symbols (ticker, name, exchange, asset_class, sector, industry) VALUES (?, ?, NULL, 'etf', 'Thematic', 'ETF') ON CONFLICT(ticker) DO UPDATE SET name = CASE WHEN ? = 1 THEN ? WHEN COALESCE(symbols.name, '') = '' OR symbols.name = symbols.ticker OR symbols.name LIKE '% ETF' THEN excluded.name ELSE symbols.name END, asset_class = COALESCE(symbols.asset_class, excluded.asset_class)",
    ).bind(ticker, preferredName, isEqualWeight, preferredName);
  });

  await env.DB.batch([...structureStatements, ...thematicItemStatements, ...equalWeightItemStatements, ...usIndexEqualWeightItemStatements, ...symbolStatements]);
  if (needsBarRefresh) {
    await refreshRecentBarsForTickers(env, allTickers, 2000);
  }
  if (needsSnapshotRefresh) {
    await recomputeDashboardFromStoredBars(env);
  }
}

function formatAutoRefreshLabel(localTime: string | null | undefined, timezone: string | null | undefined): string {
  const safeTime = parseLocalTime(localTime ?? "") ? localTime!.trim() : "08:15";
  const safeTz = timezone?.trim() || "Australia/Melbourne";
  return `${safeTime} ${safeTz} (prev US close)`;
}

async function loadDefaultConfigRow(env: Env): Promise<{
  id: string;
  timezone: string;
  eodRunLocalTime: string;
  eodRunTimeLabel: string;
} | null> {
  return await env.DB.prepare(
    "SELECT id, timezone, eod_run_local_time as eodRunLocalTime, eod_run_time_label as eodRunTimeLabel FROM dashboard_configs WHERE is_default = 1 LIMIT 1",
  ).first<{
    id: string;
    timezone: string;
    eodRunLocalTime: string;
    eodRunTimeLabel: string;
  }>();
}

async function loadOverviewTickers(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT DISTINCT di.ticker as ticker FROM dashboard_items di JOIN dashboard_groups dg ON dg.id = di.group_id JOIN dashboard_sections ds ON ds.id = dg.section_id JOIN dashboard_configs dc ON dc.id = ds.config_id WHERE dc.is_default = 1 AND di.enabled = 1 AND (ds.title LIKE '%Macro%' OR ds.title LIKE '%Equities%') ORDER BY di.ticker ASC",
  ).all<{ ticker: string }>();
  return uniqueTickers((rows.results ?? []).map((r) => r.ticker));
}

async function loadTickersMissingRecentBars(env: Env, tickers: string[], maxAgeDays = 14): Promise<string[]> {
  const unique = uniqueTickers(tickers);
  if (unique.length === 0) return [];
  const thresholdDate = new Date(Date.now() - maxAgeDays * 86400_000).toISOString().slice(0, 10);
  const lastDateByTicker = new Map<string, string | null>();
  const chunkSize = 80;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const sql = `SELECT ticker, MAX(date) as lastDate FROM daily_bars WHERE ticker IN (${chunk.map(() => "?").join(",")}) GROUP BY ticker`;
    const rows = await env.DB.prepare(sql).bind(...chunk).all<{ ticker: string; lastDate: string | null }>();
    for (const row of rows.results ?? []) {
      lastDateByTicker.set(row.ticker.toUpperCase(), row.lastDate ?? null);
    }
  }
  return unique.filter((ticker) => {
    const lastDate = lastDateByTicker.get(ticker) ?? null;
    return !lastDate || lastDate < thresholdDate;
  });
}

async function loadTickersMissingBarHistory(env: Env, tickers: string[], minBars = OVERVIEW_SPARKLINE_MIN_POINTS): Promise<string[]> {
  const unique = uniqueTickers(tickers);
  if (unique.length === 0) return [];
  const barCountByTicker = new Map<string, number>();
  const chunkSize = 80;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const sql = `SELECT ticker, COUNT(*) as barCount FROM daily_bars WHERE ticker IN (${chunk.map(() => "?").join(",")}) GROUP BY ticker`;
    const rows = await env.DB.prepare(sql).bind(...chunk).all<{ ticker: string; barCount: number }>();
    for (const row of rows.results ?? []) {
      barCountByTicker.set(row.ticker.toUpperCase(), Number(row.barCount ?? 0));
    }
  }
  return unique.filter((ticker) => (barCountByTicker.get(ticker) ?? 0) < minBars);
}

export { loadTickersMissingBarHistory };

async function maybeRefreshOverviewBars(env: Env): Promise<void> {
  const now = Date.now();
  if (now - lastOverviewBarRefreshAt < OVERVIEW_BAR_REFRESH_INTERVAL_MS) return;
  lastOverviewBarRefreshAt = now;
  const tickers = await loadOverviewTickers(env);
  if (tickers.length === 0) return;
  const staleTickers = await loadTickersMissingRecentBars(env, tickers, 14);
  const shortHistoryTickers = await loadTickersMissingBarHistory(env, tickers, OVERVIEW_SPARKLINE_MIN_POINTS);
  const refreshTickers = uniqueTickers([...staleTickers, ...shortHistoryTickers]);
  if (refreshTickers.length === 0) return;
  await refreshRecentBarsForTickers(env, refreshTickers, 400, OVERVIEW_HISTORY_LOOKBACK_DAYS);
  await recomputeDashboardFromStoredBars(env);
}

async function loadSectorPageTickers(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT DISTINCT ticker FROM (SELECT ticker as ticker FROM etf_watchlists UNION ALL SELECT ticker as ticker FROM sector_tracker_entry_symbols UNION ALL SELECT constituent_ticker as ticker FROM etf_constituents WHERE etf_ticker IN (SELECT ticker FROM etf_watchlists)) ORDER BY ticker ASC",
  ).all<{ ticker: string }>();
  return uniqueTickers((rows.results ?? []).map((r) => r.ticker));
}

async function load13fTickers(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT DISTINCT ticker FROM filings_13f_holdings WHERE report_id IN (SELECT id FROM filings_13f_reports WHERE report_quarter = (SELECT MAX(report_quarter) FROM filings_13f_reports)) ORDER BY ticker ASC",
  ).all<{ ticker: string }>();
  return uniqueTickers((rows.results ?? []).map((r) => r.ticker));
}

async function loadAdminTickers(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT DISTINCT ticker FROM (SELECT ticker as ticker FROM dashboard_items WHERE enabled = 1 UNION ALL SELECT ticker as ticker FROM etf_watchlists UNION ALL SELECT constituent_ticker as ticker FROM etf_constituents UNION ALL SELECT ticker as ticker FROM sector_tracker_entry_symbols) ORDER BY ticker ASC",
  ).all<{ ticker: string }>();
  return uniqueTickers((rows.results ?? []).map((r) => r.ticker));
}

type RefreshPage =
  | "overview"
  | "breadth"
  | "sectors"
  | "thirteenf"
  | "admin"
  | "ticker"
  | "alerts"
  | "scans"
  | "watchlist-compiler"
  | "gappers";

async function refreshPageScopedData(
  env: Env,
  page: RefreshPage,
  tickerInput?: string | null,
): Promise<{ page: RefreshPage; refreshedTickers: number; notes?: string }> {
  if (page === "overview") {
    const tickers = await loadOverviewTickers(env);
    await refreshRecentBarsForTickers(env, tickers);
    await recomputeDashboardFromStoredBars(env);
    return { page, refreshedTickers: tickers.length };
  }
  if (page === "breadth") {
    const breadth = await refreshSp500CoreBreadth(env);
    const recompute = await recomputeBreadthFromStoredBars(env);
    const sp500CountRow = await env.DB.prepare("SELECT COUNT(*) as count FROM universe_symbols WHERE universe_id = ?")
      .bind("sp500-core")
      .first<{ count: number }>();
    return {
      page,
      refreshedTickers: sp500CountRow?.count ?? 0,
      notes: `SP500 bars pulled: ${breadth.barCount}. Breadth recomputed for ${recompute.universeCount} universes.`,
    };
  }
  if (page === "sectors") {
    const tickers = await loadSectorPageTickers(env);
    await refreshRecentBarsForTickers(env, tickers);
    return { page, refreshedTickers: tickers.length };
  }
  if (page === "thirteenf") {
    const tickers = await load13fTickers(env);
    await refreshRecentBarsForTickers(env, tickers);
    return { page, refreshedTickers: tickers.length };
  }
  if (page === "admin") {
    const tickers = await loadAdminTickers(env);
    await refreshRecentBarsForTickers(env, tickers);
    await recomputeDashboardFromStoredBars(env);
    await recomputeBreadthFromStoredBars(env);
    return { page, refreshedTickers: tickers.length };
  }
  if (page === "ticker") {
    const ticker = tickerInput?.trim().toUpperCase() ?? "";
    if (!/^[A-Z.\-^]{1,20}$/.test(ticker)) {
      throw new Error("Valid ticker is required for ticker page refresh.");
    }
    await refreshRecentBarsForTickers(env, [ticker]);
    return { page, refreshedTickers: 1 };
  }
  if (page === "alerts") {
    const reconcile = await reconcileAlertsFromMailboxAdapters(env, 25);
    await cleanupOldAlertsData(env, 30);
    return {
      page,
      refreshedTickers: reconcile.alertsIngested,
      notes: `Alerts ingest: ${reconcile.alertsIngested} new, ${reconcile.duplicates} duplicate, ${reconcile.parseFailures} parse failures.`,
    };
  }
  if (page === "scans") {
    const snapshot = await refreshScansSnapshot(env);
    return {
      page,
      refreshedTickers: snapshot.rowCount,
      notes: `Refreshed ${snapshot.presetName} scan snapshot with ${snapshot.rowCount} ranked rows.`,
    };
  }
  if (page === "watchlist-compiler") {
    const refreshed = await compileActiveWatchlistSets(env);
    return {
      page,
      refreshedTickers: refreshed.compiledRows,
      notes: `Compiled ${refreshed.compiledSets} watchlist set${refreshed.compiledSets === 1 ? "" : "s"} and stored ${refreshed.compiledRows} compiled rows.`,
    };
  }
  if (page === "gappers") {
    const snapshot = await refreshGappersSnapshot(env, 25);
    return {
      page,
      refreshedTickers: snapshot.rowCount,
      notes: `Refreshed gappers snapshot with ${snapshot.rowCount} ranked rows.`,
    };
  }
  return { page, refreshedTickers: 0, notes: "No market tickers are tracked on this page." };
}

async function maybeRunAlertsHousekeeping(env: Env): Promise<void> {
  const now = Date.now();
  if (now - lastAlertsHousekeepingAt < ALERTS_HOUSEKEEPING_INTERVAL_MS) return;
  lastAlertsHousekeepingAt = now;
  try {
    await cleanupOldAlertsData(env, 30);
  } catch (error) {
    console.error("alerts cleanup failed", error);
  }
  if ((env.ALERTS_RECONCILE_ENABLED ?? "false") !== "true") return;
  try {
    await reconcileAlertsFromMailboxAdapters(env, 30);
  } catch (error) {
    console.error("alerts reconcile failed", error);
  }
}

async function maybeRunScanningHousekeeping(env: Env): Promise<void> {
  const now = Date.now();
  if (now - lastScanningHousekeepingAt < SCANNING_HOUSEKEEPING_INTERVAL_MS) return;
  lastScanningHousekeepingAt = now;
  try {
    await cleanupOldScanningData(env, 1);
  } catch (error) {
    console.error("scanning cleanup failed", error);
  }
}

async function maybeRunGappersHousekeeping(env: Env): Promise<void> {
  const now = Date.now();
  if (now - lastGappersHousekeepingAt < GAPPERS_HOUSEKEEPING_INTERVAL_MS) return;
  lastGappersHousekeepingAt = now;
  try {
    await cleanupOldGappersData(env, 1);
  } catch (error) {
    console.error("gappers cleanup failed", error);
  }
}

async function maybeRunScansPageHousekeeping(env: Env): Promise<void> {
  const now = Date.now();
  if (now - lastScansPageHousekeepingAt < SCANS_PAGE_HOUSEKEEPING_INTERVAL_MS) return;
  lastScansPageHousekeepingAt = now;
  try {
    await cleanupOldScansPageData(env, 7);
  } catch (error) {
    console.error("scans page cleanup failed", error);
  }
}

type BreadthSentiment = {
  fearGreed?: number | null;
  putCall?: number | null;
  metrics?: Record<string, unknown>;
  dataSource?: string | null;
};

const hasUsableBreadthRow = (row: { advancers?: unknown; decliners?: unknown; unchanged?: unknown; metrics?: unknown }): boolean => {
  const metrics = (row.metrics ?? {}) as Record<string, unknown>;
  const memberCountRaw = metrics.memberCount;
  if (typeof memberCountRaw === "number" && Number.isFinite(memberCountRaw)) {
    return memberCountRaw > 0;
  }
  const adv = typeof row.advancers === "number" && Number.isFinite(row.advancers) ? row.advancers : 0;
  const dec = typeof row.decliners === "number" && Number.isFinite(row.decliners) ? row.decliners : 0;
  const unc = typeof row.unchanged === "number" && Number.isFinite(row.unchanged) ? row.unchanged : 0;
  return adv + dec + unc > 0;
};

async function ensureFreshSp500BreadthSafe(env: Env): Promise<void> {
  let latestSnapshotAsOf: string | null = null;
  try {
    const latestSnapshot = await env.DB.prepare(
      "SELECT as_of_date as asOfDate FROM snapshots_meta ORDER BY generated_at DESC LIMIT 1",
    ).first<{ asOfDate: string | null }>();
    latestSnapshotAsOf = latestSnapshot?.asOfDate ?? null;
  } catch {
    latestSnapshotAsOf = null;
  }

  const latestSp500Row = await env.DB.prepare(
    "SELECT as_of_date as asOfDate, advancers, decliners, unchanged, sentiment_json as sentimentJson FROM breadth_snapshots WHERE universe_id = 'sp500-core' ORDER BY as_of_date DESC LIMIT 1",
  ).first<{ asOfDate: string | null; advancers: number; decliners: number; unchanged: number; sentimentJson: string | null }>();

  if (!latestSp500Row) {
    try {
      await refreshSp500CoreBreadth(env);
    } catch (error) {
      console.error("sp500 core on-demand refresh failed; falling back to full snapshot refresh", error);
      await ensureBreadthRowsSafe(env);
    }
    return;
  }
  const sentiment = parseBreadthSentiment(latestSp500Row.sentimentJson);
  const usable = hasUsableBreadthRow({
    advancers: latestSp500Row.advancers,
    decliners: latestSp500Row.decliners,
    unchanged: latestSp500Row.unchanged,
    metrics: sentiment.metrics ?? null,
  });
  const isStaleVsSnapshot =
    Boolean(latestSnapshotAsOf) &&
    Boolean(latestSp500Row.asOfDate) &&
    String(latestSp500Row.asOfDate) < String(latestSnapshotAsOf);
  if (!usable || isStaleVsSnapshot) {
    try {
      await refreshSp500CoreBreadth(env);
    } catch (error) {
      console.error("sp500 core on-demand refresh failed; falling back to full snapshot refresh", error);
      await ensureBreadthRowsSafe(env);
    }
  }
}

function parseBreadthSentiment(raw: unknown): BreadthSentiment {
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as BreadthSentiment;
  } catch {
    return {};
  }
}

async function getTicker1dStats(db: D1Database, ticker: string): Promise<{ change1d: number; lastPrice: number }> {
  const bars = await db.prepare("SELECT c FROM daily_bars WHERE ticker = ? ORDER BY date DESC LIMIT 2")
    .bind(ticker)
    .all<{ c: number }>();
  const rows = bars.results ?? [];
  const lastPrice = rows[0]?.c ?? 0;
  const prev = rows[1]?.c ?? 0;
  if (!lastPrice || !prev) return { change1d: 0, lastPrice };
  return { change1d: ((lastPrice - prev) / prev) * 100, lastPrice };
}

async function get1dStatsMap(env: Env, tickers: string[]): Promise<Map<string, { change1d: number; lastPrice: number; source: string }>> {
  const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean)));
  const map = new Map<string, { change1d: number; lastPrice: number; source: string }>();
  for (const ticker of unique) {
    const fallback = await getTicker1dStats(env.DB, ticker);
    map.set(ticker, { change1d: fallback.change1d, lastPrice: fallback.lastPrice, source: "daily-bars" });
  }
  try {
    const provider = getProvider(env);
    const snapshots = provider.getQuoteSnapshot ? await provider.getQuoteSnapshot(unique) : {};
    for (const ticker of unique) {
      const snap = snapshots[ticker];
      if (!snap?.prevClose || !snap?.price) continue;
      map.set(ticker, {
        change1d: ((snap.price - snap.prevClose) / snap.prevClose) * 100,
        lastPrice: snap.price,
        source: "provider-snapshot",
      });
    }
  } catch (error) {
    console.error("get quote snapshots failed, using daily bars fallback", error);
  }
  return map;
}

async function refreshRecentBarsForTickers(env: Env, tickers: string[], maxTickers = 1600, lookbackDays = 21): Promise<void> {
  const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean))).slice(0, Math.max(1, maxTickers));
  if (unique.length === 0) return;
  let provider: ReturnType<typeof getProvider> | null = null;
  try {
    provider = getProvider(env);
  } catch {
    return;
  }
  try {
    const end = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - Math.max(1, lookbackDays) * 86400_000).toISOString().slice(0, 10);
    const bars = await provider.getDailyBars(unique, start, end);
    if (bars.length === 0) return;
    const stmts = bars.map((b) =>
      env.DB.prepare(
        "INSERT OR REPLACE INTO daily_bars (ticker, date, o, h, l, c, volume) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(b.ticker.toUpperCase(), b.date, b.o, b.h, b.l, b.c, b.volume ?? 0),
    );
    await env.DB.batch(stmts);
  } catch (error) {
    console.error("refresh recent bars for tickers failed", error);
  }
}

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/status", async (c) => {
  const page = (c.req.query("page") ?? "overview").trim();
  let config:
    | {
        id: string;
        name: string;
        timezone: string;
        eodRunLocalTime: string;
        eodRunTimeLabel: string;
      }
    | null = null;
  try {
    config = await c.env.DB.prepare(
      "SELECT id, name, timezone, eod_run_local_time as eodRunLocalTime, eod_run_time_label as eodRunTimeLabel FROM dashboard_configs WHERE is_default = 1 LIMIT 1",
    ).first<{ id: string; name: string; timezone: string; eodRunLocalTime: string; eodRunTimeLabel: string }>();
  } catch {
    const legacy = await c.env.DB.prepare(
      "SELECT id, name, timezone, eod_run_time_label as eodRunTimeLabel FROM dashboard_configs WHERE is_default = 1 LIMIT 1",
    ).first<{ id: string; name: string; timezone: string; eodRunTimeLabel: string }>();
    config = legacy
      ? {
          ...legacy,
          eodRunLocalTime: "08:15",
          eodRunTimeLabel: legacy.eodRunTimeLabel || formatAutoRefreshLabel("08:15", legacy.timezone),
        }
      : null;
  }

  const overviewLatest = await c.env.DB.prepare(
    "SELECT as_of_date as asOfDate, generated_at as generatedAt, provider_label as providerLabel FROM snapshots_meta WHERE config_id = ? ORDER BY as_of_date DESC, generated_at DESC LIMIT 1",
  )
    .bind(config?.id ?? "default")
    .first<{ asOfDate?: string; generatedAt?: string; providerLabel?: string; as_of_date?: string; generated_at?: string; provider_label?: string }>();
  const breadthLatest = await c.env.DB.prepare(
    "SELECT as_of_date as asOfDate, generated_at as generatedAt FROM breadth_snapshots ORDER BY as_of_date DESC, generated_at DESC LIMIT 1",
  )
    .first<{ asOfDate?: string; generatedAt?: string; as_of_date?: string; generated_at?: string }>();

  const normalizedOverview = {
    lastUpdated: overviewLatest?.generatedAt ?? overviewLatest?.generated_at ?? null,
    asOfDate: overviewLatest?.asOfDate ?? overviewLatest?.as_of_date ?? null,
    providerLabel: overviewLatest?.providerLabel ?? overviewLatest?.provider_label ?? null,
  };
  const normalizedBreadth = {
    lastUpdated: breadthLatest?.generatedAt ?? breadthLatest?.generated_at ?? null,
    asOfDate: breadthLatest?.asOfDate ?? breadthLatest?.as_of_date ?? null,
  };
  const useBreadthStatus = page === "breadth";
  const normalizedLastUpdated = useBreadthStatus
    ? normalizedBreadth.lastUpdated ?? normalizedOverview.lastUpdated
    : normalizedOverview.lastUpdated ?? normalizedBreadth.lastUpdated;
  const normalizedAsOf = useBreadthStatus
    ? normalizedBreadth.asOfDate ?? normalizedOverview.asOfDate
    : normalizedOverview.asOfDate ?? normalizedBreadth.asOfDate;
  const normalizedProvider = normalizedOverview.providerLabel ?? "Alpaca (IEX Delayed Daily Bars)";

  return c.json({
    configId: config?.id ?? "default",
    timezone: config?.timezone ?? c.env.APP_TIMEZONE ?? "Australia/Melbourne",
    autoRefreshLabel: formatAutoRefreshLabel(config?.eodRunLocalTime, config?.timezone),
    autoRefreshLocalTime: config?.eodRunLocalTime ?? "08:15",
    lastUpdated: normalizedLastUpdated ?? (normalizedAsOf ? `${normalizedAsOf}T00:00:00Z` : null),
    asOfDate: normalizedAsOf,
    providerLabel: normalizedProvider,
    dataProvider: c.env.DATA_PROVIDER ?? "alpaca",
  });
});

app.get("/api/dashboard", async (c) => {
  const configId = c.req.query("configId") ?? "default";
  const date = c.req.query("date");
  await ensureOverviewCatalogCoverage(c.env);
  if (!date && await isOverviewSnapshotStale(c.env, configId)) {
    const tickers = await loadOverviewTickers(c.env);
    await refreshRecentBarsForTickers(c.env, tickers, 400, OVERVIEW_HISTORY_LOOKBACK_DAYS);
    await recomputeDashboardFromStoredBars(c.env, undefined, configId);
  }
  await maybeRefreshOverviewBars(c.env);
  const data = await loadSnapshot(c.env, configId, date);
  c.header("Cache-Control", "public, max-age=300");
  return c.json(data);
});

app.get("/api/breadth", async (c) => {
  const requestedUniverseId = c.req.query("universeId") ?? "sp500-core";
  const limit = Number(c.req.query("limit") ?? 60);
  if (requestedUniverseId === "sp500-core") {
    await ensureFreshSp500BreadthSafe(c.env);
  }
  const loadRows = async (universeId: string) =>
    c.env.DB.prepare(
      "SELECT as_of_date as asOfDate, universe_id as universeId, advancers, decliners, unchanged, pct_above_20ma as pctAbove20MA, pct_above_50ma as pctAbove50MA, pct_above_200ma as pctAbove200MA, new_20d_highs as new20DHighs, new_20d_lows as new20DLows, median_return_1d as medianReturn1D, median_return_5d as medianReturn5D, sentiment_json as sentimentJson FROM breadth_snapshots WHERE universe_id = ? ORDER BY as_of_date DESC LIMIT ?",
    )
      .bind(universeId, limit)
      .all();

  const parseRows = (rawRows: any[]) =>
    rawRows.map((row: any) => {
      const sentiment = parseBreadthSentiment(row.sentimentJson);
      return {
        ...row,
        metrics: sentiment.metrics ?? null,
        dataSource: sentiment.dataSource ?? null,
      };
    });

  let universeId = requestedUniverseId;
  let rows = await loadRows(universeId);
  if ((rows.results ?? []).length === 0) {
    await ensureBreadthRowsSafe(c.env);
    rows = await loadRows(universeId);
  }

  let parsedRowsDesc = parseRows(rows.results ?? []);
  let usableRowsDesc = parsedRowsDesc.filter((row) => hasUsableBreadthRow(row));

  const parsedRows = usableRowsDesc.reverse().map((row: any) => {
    const sentiment = parseBreadthSentiment(row.sentimentJson);
    return {
      ...row,
      metrics: sentiment.metrics ?? null,
      dataSource: sentiment.dataSource ?? null,
    };
  });
  return c.json({ requestedUniverseId, universeId, rows: parsedRows });
});

app.get("/api/breadth/summary", async (c) => {
  const requestedDate = c.req.query("date");
  if (!requestedDate) {
    await ensureFreshSp500BreadthSafe(c.env);
  }
  const selectCols =
    "b.as_of_date as asOfDate, b.universe_id as universeId, COALESCE(u.name, b.universe_id) as universeName, b.advancers, b.decliners, b.unchanged, b.pct_above_20ma as pctAbove20MA, b.pct_above_50ma as pctAbove50MA, b.pct_above_200ma as pctAbove200MA, b.new_20d_highs as new20DHighs, b.new_20d_lows as new20DLows, b.median_return_1d as medianReturn1D, b.median_return_5d as medianReturn5D, b.sentiment_json as sentimentJson";

  const loadRowsByDate = async (asOfDate: string) =>
    c.env.DB.prepare(`SELECT ${selectCols} FROM breadth_snapshots b LEFT JOIN universes u ON u.id = b.universe_id WHERE b.as_of_date = ? ORDER BY b.universe_id ASC`)
      .bind(asOfDate)
      .all();

  const loadLatestRows = async () =>
    c.env.DB.prepare(`SELECT ${selectCols} FROM breadth_snapshots b LEFT JOIN universes u ON u.id = b.universe_id ORDER BY b.universe_id ASC, b.as_of_date DESC`)
      .all();

  if (requestedDate) {
    const rows = await loadRowsByDate(requestedDate);
    const parsedRequestedRows = (rows.results ?? []).map((row: any) => {
      const sentiment = parseBreadthSentiment(row.sentimentJson);
      return {
        ...row,
        metrics: sentiment.metrics ?? null,
        dataSource: sentiment.dataSource ?? null,
      };
    });
    const usableRequestedRows = parsedRequestedRows.filter((row) => hasUsableBreadthRow(row));
    const requestedRowById = new Map(usableRequestedRows.map((r: any) => [r.universeId, r]));
    const requestedOrderedRows = [
      requestedRowById.get("sp500-core"),
      requestedRowById.get("nasdaq-core"),
      requestedRowById.get("nyse-core"),
      requestedRowById.get("russell2000-core"),
      requestedRowById.get("overall-market-proxy"),
    ].filter(Boolean);

    return c.json({
      asOfDate: requestedDate,
      rows: requestedOrderedRows,
      unavailable: [
        { id: "worden-common-stock-universe", name: "Overall Market (Worden Common Stock Universe)", reason: "Proprietary universe; no free direct feed is available" },
      ],
    });
  }

  let rows = await loadLatestRows();
  if ((rows.results ?? []).length === 0) {
    await ensureBreadthRowsSafe(c.env);
    rows = await loadLatestRows();
  }
  if ((rows.results ?? []).length === 0) {
    return c.json({
      asOfDate: null,
      rows: [],
      unavailable: [
        { id: "nyse-core", name: "NYSE", reason: "NYSE breadth data is currently unavailable from configured free sources" },
        { id: "worden-common-stock-universe", name: "Overall Market (Worden Common Stock Universe)", reason: "Proprietary universe; no free direct feed is available" },
      ],
    });
  }

  const parsedRows = (rows.results ?? []).map((row: any) => {
    const sentiment = parseBreadthSentiment(row.sentimentJson);
    return {
      ...row,
      metrics: sentiment.metrics ?? null,
      dataSource: sentiment.dataSource ?? null,
    };
  });
  const rowById = new Map<string, any>();
  for (const row of parsedRows) {
    if (!hasUsableBreadthRow(row)) continue;
    if (!rowById.has(row.universeId)) {
      rowById.set(row.universeId, row);
    }
  }

  const orderedRows = [
    rowById.get("sp500-core"),
    rowById.get("nasdaq-core"),
    rowById.get("nyse-core"),
    rowById.get("russell2000-core"),
    rowById.get("overall-market-proxy"),
  ].filter(Boolean);

  const present = new Set(orderedRows.map((r: any) => r.universeId));
  const unavailable: Array<{ id: string; name: string; reason: string }> = [];
  if (!present.has("sp500-core")) {
    unavailable.push({
      id: "sp500-core",
      name: "S&P 500",
      reason: "S&P 500 breadth data is currently unavailable from configured free sources",
    });
  }
  if (!present.has("nasdaq-core")) {
    unavailable.push({
      id: "nasdaq-core",
      name: "NASDAQ",
      reason: "NASDAQ breadth data is currently unavailable from configured free sources",
    });
  }
  if (!present.has("nyse-core")) {
    unavailable.push({
      id: "nyse-core",
      name: "NYSE",
      reason: "NYSE breadth data is currently unavailable from configured free sources",
    });
  }
  unavailable.push({
    id: "worden-common-stock-universe",
    name: "Overall Market (Worden Common Stock Universe)",
    reason: "Proprietary universe; no free direct feed is available",
  });

  return c.json({
    asOfDate: orderedRows.reduce<string | null>((acc, row: any) => {
      if (!row?.asOfDate) return acc;
      if (!acc) return row.asOfDate;
      return row.asOfDate > acc ? row.asOfDate : acc;
    }, null),
    rows: orderedRows,
    unavailable,
  });
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
    "SELECT s.sector, s.name, d.ticker, d.date, d.c FROM daily_bars d JOIN symbols s ON s.ticker = d.ticker WHERE s.sector IS NOT NULL AND d.date >= date('now', ?) ORDER BY s.sector, d.ticker, d.date",
  )
    .bind(`-${days + 7} day`)
    .all<{ sector: string; name: string | null; ticker: string; date: string; c: number }>();

  const bySector = new Map<string, Map<string, { name: string | null; closes: number[] }>>();
  for (const r of rows.results ?? []) {
    const sectorMap = bySector.get(r.sector) ?? new Map<string, { name: string | null; closes: number[] }>();
    const tickerRow = sectorMap.get(r.ticker) ?? { name: r.name ?? null, closes: [] };
    tickerRow.closes.push(r.c);
    if (!tickerRow.name && r.name) tickerRow.name = r.name;
    sectorMap.set(r.ticker, tickerRow);
    bySector.set(r.sector, sectorMap);
  }

  const out = [...bySector.entries()].map(([sector, tickers]) => {
    const tickerRows = [...tickers.entries()]
      .map(([ticker, data]) => {
        const hasWindow = data.closes.length > 6;
        const trend5d = hasWindow ? ((data.closes[data.closes.length - 1] - data.closes[data.closes.length - 6]) / data.closes[data.closes.length - 6]) * 100 : 0;
        return {
          ticker,
          name: data.name,
          trend5d,
          lastPrice: data.closes[data.closes.length - 1] ?? 0,
          hasWindow,
        };
      })
      .sort((a, b) => b.trend5d - a.trend5d);
    const valid = tickerRows.filter((v) => v.hasWindow);
    const score = valid.length > 0 ? valid.reduce((acc, cur) => acc + cur.trend5d, 0) / valid.length : 0;
    return { sector, trend5d: score, symbolCount: tickers.size, tickers: tickerRows };
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
  const links = await c.env.DB.prepare(
    "SELECT es.entry_id as entryId, es.ticker, s.name FROM sector_tracker_entry_symbols es LEFT JOIN symbols s ON s.ticker = es.ticker WHERE es.entry_id IN (SELECT id FROM sector_tracker_entries WHERE substr(event_date, 1, 7) = ?) ORDER BY es.ticker",
  )
    .bind(month)
    .all<{ entryId: string; ticker: string; name: string | null }>();
  const symbolMap = new Map<string, Array<{ ticker: string; name: string | null }>>();
  for (const link of links.results ?? []) {
    const arr = symbolMap.get(link.entryId) ?? [];
    arr.push({ ticker: link.ticker, name: link.name });
    symbolMap.set(link.entryId, arr);
  }
  return c.json({
    month,
    rows: (rows.results ?? []).map((r: any) => ({
      ...r,
      symbols: symbolMap.get(r.id) ?? [],
    })),
  });
});

app.get("/api/etfs/sector", async (c) => {
  const rows = await listEtfWatchlistRows(c.env, "sector");
  await refreshRecentBarsForTickers(c.env, rows.map((r: any) => r.ticker));
  const statsMap = await get1dStatsMap(c.env, rows.map((r: any) => r.ticker));
  const withStats = await Promise.all(
    rows.map(async (row: any) => {
      const stats = statsMap.get(String(row.ticker).toUpperCase());
      return { ...row, change1d: stats?.change1d ?? 0, lastPrice: stats?.lastPrice ?? 0, priceSource: stats?.source ?? "daily-bars" };
    }),
  );
  withStats.sort((a, b) => b.change1d - a.change1d);
  return c.json({ rows: withStats });
});

app.get("/api/etfs/industry", async (c) => {
  await ensureEtfCatalogCoverage(c.env);
  const rows = await listEtfWatchlistRows(c.env, "industry");
  await refreshRecentBarsForTickers(c.env, rows.map((r: any) => r.ticker));
  const statsMap = await get1dStatsMap(c.env, rows.map((r: any) => r.ticker));
  const withStats = await Promise.all(
    rows.map(async (row: any) => {
      const stats = statsMap.get(String(row.ticker).toUpperCase());
      return { ...row, change1d: stats?.change1d ?? 0, lastPrice: stats?.lastPrice ?? 0, priceSource: stats?.source ?? "daily-bars" };
    }),
  );
  return c.json({ rows: withStats });
});

app.get("/api/etf/:ticker/constituents", async (c) => {
  await ensureEtfCatalogCoverage(c.env);
  const ticker = c.req.param("ticker").toUpperCase();
  const forceSync = c.req.query("force") === "1";
  const etf = await (async () => {
    try {
      return await c.env.DB.prepare(
        "SELECT list_type as listType, parent_sector as parentSector, industry, ticker, fund_name as fundName, sort_order as sortOrder, source_url as sourceUrl FROM etf_watchlists WHERE ticker = ? ORDER BY list_type ASC LIMIT 1",
      )
        .bind(ticker)
        .first();
    } catch {
      return await c.env.DB.prepare(
        "SELECT list_type as listType, parent_sector as parentSector, industry, ticker, fund_name as fundName, sort_order as sortOrder FROM etf_watchlists WHERE ticker = ? ORDER BY list_type ASC LIMIT 1",
      )
        .bind(ticker)
        .first();
    }
  })();
  if (!etf) return c.json({ error: "ETF ticker not found in watchlists" }, 404);

  const rows = await c.env.DB.prepare(
    "SELECT constituent_ticker as ticker, constituent_name as name, weight, as_of_date as asOfDate, source, updated_at as updatedAt FROM etf_constituents WHERE etf_ticker = ? ORDER BY weight DESC, ticker ASC",
  )
    .bind(ticker)
    .all();
  const baseRows = rows.results ?? [];

  let statusRaw = await c.env.DB.prepare(
    "SELECT etf_ticker as etfTicker, last_synced_at as lastSyncedAt, status, error, source, records_count as recordsCount FROM etf_constituent_sync_status WHERE etf_ticker = ?",
  )
    .bind(ticker)
    .first<{ etfTicker: string; lastSyncedAt: string | null; status: string | null; error: string | null; source: string | null; recordsCount: number }>();
  let status = statusRaw ? normalizeEtfSyncStatusRow(statusRaw) : null;
  const hasKnownError = status?.status === "error";
  const hasNoRecords = baseRows.length === 0;
  const isRecentError = hasKnownError && !isStaleDate(status?.lastSyncedAt, 1);
  const hasCachedRows = baseRows.length > 0;
  const shouldSync =
    forceSync ||
    (hasNoRecords && !isRecentError) ||
    (hasCachedRows && isStaleDate(status?.lastSyncedAt, 45)) ||
    (hasKnownError && !isRecentError && hasCachedRows);
  let warning: string | null = null;
  if (shouldSync) {
    try {
      await syncEtfConstituents(c.env, ticker);
      statusRaw = await c.env.DB.prepare(
        "SELECT etf_ticker as etfTicker, last_synced_at as lastSyncedAt, status, error, source, records_count as recordsCount FROM etf_constituent_sync_status WHERE etf_ticker = ?",
      )
        .bind(ticker)
        .first<{ etfTicker: string; lastSyncedAt: string | null; status: string | null; error: string | null; source: string | null; recordsCount: number }>();
      status = statusRaw ? normalizeEtfSyncStatusRow(statusRaw) : null;
    } catch (error) {
      if (!hasCachedRows) {
        warning = error instanceof Error ? error.message : "Constituent pull failed";
      }
      statusRaw = await c.env.DB.prepare(
        "SELECT etf_ticker as etfTicker, last_synced_at as lastSyncedAt, status, error, source, records_count as recordsCount FROM etf_constituent_sync_status WHERE etf_ticker = ?",
      )
        .bind(ticker)
        .first<{ etfTicker: string; lastSyncedAt: string | null; status: string | null; error: string | null; source: string | null; recordsCount: number }>();
      status = statusRaw ? normalizeEtfSyncStatusRow(statusRaw) : status;
    }
  }

  const finalRows = shouldSync
    ? (await c.env.DB.prepare(
      "SELECT constituent_ticker as ticker, constituent_name as name, weight, as_of_date as asOfDate, source, updated_at as updatedAt FROM etf_constituents WHERE etf_ticker = ? ORDER BY weight DESC, ticker ASC",
    )
      .bind(ticker)
      .all()).results ?? []
    : baseRows;
  const finalHasNoRecords = finalRows.length === 0;

  // Limit per-request quote/bar fanout to avoid worker subrequest caps on large constituent sets.
  const pricedTickers = finalRows.slice(0, 80).map((r: any) => r.ticker);
  await refreshRecentBarsForTickers(c.env, pricedTickers, 80);
  const statsMap = await get1dStatsMap(c.env, pricedTickers);
  const rowsWithStats = finalRows.map((row: any) => {
    const stats = statsMap.get(String(row.ticker).toUpperCase());
    return {
      ...row,
      change1d: stats?.change1d ?? 0,
      lastPrice: stats?.lastPrice ?? 0,
      priceSource: stats?.source ?? "daily-bars",
    };
  });
  if (!warning && status?.status === "error" && status.error) {
    warning = status.error;
  }
  if (!warning && !forceSync && finalHasNoRecords) {
    warning = "No cached constituents yet for this ETF. Constituents are loaded from the database and updated by scheduled/admin sync.";
  }
  if (!warning && isRecentError && finalHasNoRecords) {
    warning = "Constituent sync is temporarily throttled after a recent provider-limit error. Try again later or run monthly sync.";
  }
  return c.json({
    etf,
    rows: rowsWithStats,
    syncStatus: status ?? null,
    warning,
  });
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
    const symbolUpserts = await Promise.all(
      symbols.map(async (ticker) => {
        const meta = await resolveTickerMeta(ticker, c.env).catch(() => null);
        return c.env.DB.prepare(
          "INSERT OR IGNORE INTO symbols (ticker, name, exchange, asset_class, sector, industry) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(
          ticker,
          meta?.name ?? ticker,
          meta?.exchange ?? null,
          meta?.assetClass ?? null,
          null,
          null,
        );
      }),
    );
    const linkInserts = symbols.map((ticker) =>
      c.env.DB.prepare("INSERT OR IGNORE INTO sector_tracker_entry_symbols (entry_id, ticker) VALUES (?, ?)")
        .bind(id, ticker),
    );
    const stmts = [...symbolUpserts, ...linkInserts];
    await c.env.DB.batch(stmts);
  }
  return c.json({ ok: true, id });
});

app.patch("/api/sectors/entries/:id", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT id FROM sector_tracker_entries WHERE id = ?").bind(id).first<{ id: string }>();
  if (!existing) return c.json({ error: "Sector tracker entry not found." }, 404);

  const body = (await c.req.json()) as {
    sectorName?: string;
    eventDate?: string;
    trendScore?: number;
    notes?: string | null;
    narrativeId?: string | null;
    symbols?: string[];
  };
  const sectorName = body.sectorName?.trim();
  const eventDate = body.eventDate?.trim();
  if (!sectorName || !eventDate) return c.json({ error: "sectorName and eventDate are required" }, 400);

  await c.env.DB.prepare(
    "UPDATE sector_tracker_entries SET sector_name = ?, event_date = ?, trend_score = ?, notes = ?, narrative_id = ? WHERE id = ?",
  )
    .bind(sectorName, eventDate, body.trendScore ?? 0, body.notes ?? null, body.narrativeId ?? null, id)
    .run();

  const symbols = uniqueTickers(body.symbols ?? []).filter((s) => /^[A-Z.\-^]{1,20}$/.test(s));
  const symbolUpserts = await Promise.all(
    symbols.map(async (ticker) => {
      const meta = await resolveTickerMeta(ticker, c.env).catch(() => null);
      return c.env.DB.prepare(
        "INSERT OR IGNORE INTO symbols (ticker, name, exchange, asset_class, sector, industry) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(
        ticker,
        meta?.name ?? ticker,
        meta?.exchange ?? null,
        meta?.assetClass ?? null,
        null,
        null,
      );
    }),
  );
  const deleteLinks = c.env.DB.prepare("DELETE FROM sector_tracker_entry_symbols WHERE entry_id = ?").bind(id);
  const insertLinks = symbols.map((ticker) =>
    c.env.DB.prepare("INSERT OR IGNORE INTO sector_tracker_entry_symbols (entry_id, ticker) VALUES (?, ?)")
      .bind(id, ticker),
  );
  await c.env.DB.batch([deleteLinks, ...symbolUpserts, ...insertLinks]);
  return c.json({ ok: true, id });
});

app.delete("/api/sectors/entries/:id", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT id FROM sector_tracker_entries WHERE id = ?").bind(id).first<{ id: string }>();
  if (!existing) return c.json({ error: "Sector tracker entry not found." }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM sector_tracker_entry_symbols WHERE entry_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM sector_tracker_entries WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true, id });
});

app.get("/api/admin/ticker-meta/:ticker", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const ticker = c.req.param("ticker").toUpperCase();
  if (!/^[A-Z.\-^]{1,20}$/.test(ticker)) return c.json({ error: "Invalid ticker" }, 400);
  const meta = await resolveTickerMeta(ticker, c.env);
  return c.json({
    ticker,
    name: meta?.name ?? null,
    exchange: meta?.exchange ?? null,
    assetClass: meta?.assetClass ?? null,
  });
});

app.post("/api/admin/etfs", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json()) as {
    listType: "sector" | "industry";
    parentSector?: string | null;
    industry?: string | null;
    ticker: string;
    fundName?: string | null;
    sourceUrl?: string | null;
  };
  const listType = body.listType === "industry" ? "industry" : "sector";
  const ticker = body.ticker?.trim().toUpperCase();
  if (!ticker) return c.json({ error: "ticker is required" }, 400);
  const meta = await resolveTickerMeta(ticker, c.env);
  const fundName = body.fundName?.trim() || meta?.name || ticker;
  const sourceUrl = body.sourceUrl?.trim() || null;
  const order = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), 0) + 1 as nextOrder FROM etf_watchlists WHERE list_type = ? AND COALESCE(parent_sector, '') = COALESCE(?, '') AND COALESCE(industry, '') = COALESCE(?, '')",
  )
    .bind(listType, body.parentSector ?? null, body.industry ?? null)
    .first<{ nextOrder: number }>();
  const commonStatements = [
    c.env.DB.prepare("INSERT OR REPLACE INTO symbols (ticker, name, exchange, asset_class, sector, industry) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(ticker, meta?.name ?? fundName, meta?.exchange ?? "NYSEARCA", "etf", body.parentSector ?? null, body.industry ?? null),
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO etf_constituent_sync_status (etf_ticker, last_synced_at, status, error, source, records_count, updated_at) VALUES (?, NULL, 'pending', NULL, 'watchlist:add', 0, CURRENT_TIMESTAMP)",
    ).bind(ticker),
  ];
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO etf_watchlists (list_type, parent_sector, industry, ticker, fund_name, sort_order, source_url) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(list_type, ticker) DO UPDATE SET parent_sector = excluded.parent_sector, industry = excluded.industry, fund_name = excluded.fund_name, source_url = excluded.source_url",
      ).bind(
        listType,
        body.parentSector ?? null,
        body.industry ?? null,
        ticker,
        fundName,
        order?.nextOrder ?? 1,
        sourceUrl,
      ),
      ...commonStatements,
    ]);
  } catch {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO etf_watchlists (list_type, parent_sector, industry, ticker, fund_name, sort_order) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(list_type, ticker) DO UPDATE SET parent_sector = excluded.parent_sector, industry = excluded.industry, fund_name = excluded.fund_name",
      ).bind(
        listType,
        body.parentSector ?? null,
        body.industry ?? null,
        ticker,
        fundName,
        order?.nextOrder ?? 1,
      ),
      ...commonStatements,
    ]);
  }
  await upsertAudit(c.env, "default", "ETF_WATCHLIST_ADD", { listType, ticker, fundName, parentSector: body.parentSector, industry: body.industry, sourceUrl });
  return c.json({ ok: true, ticker, sourceUrl });
});

app.delete("/api/admin/etfs/:listType/:ticker", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const listTypeRaw = c.req.param("listType").toLowerCase();
  const listType = listTypeRaw === "industry" ? "industry" : listTypeRaw === "sector" ? "sector" : null;
  if (!listType) return c.json({ error: "Invalid listType" }, 400);
  const ticker = c.req.param("ticker").toUpperCase();
  if (!ticker) return c.json({ error: "Ticker is required" }, 400);
  const existing = await c.env.DB.prepare("SELECT ticker FROM etf_watchlists WHERE list_type = ? AND ticker = ?")
    .bind(listType, ticker)
    .first();
  if (!existing) return c.json({ error: "ETF not found in watchlist" }, 404);
  await c.env.DB.prepare("DELETE FROM etf_watchlists WHERE list_type = ? AND ticker = ?")
    .bind(listType, ticker)
    .run();
  await upsertAudit(c.env, "default", "ETF_WATCHLIST_DELETE", { listType, ticker });
  return c.json({ ok: true, ticker, listType });
});

app.patch("/api/admin/etf-source/:ticker", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const ticker = c.req.param("ticker").toUpperCase();
  if (!/^[A-Z.\-^]{1,20}$/.test(ticker)) return c.json({ error: "Valid ticker is required" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { sourceUrl?: string | null };
  const sourceUrl = body.sourceUrl?.trim() || null;
  const existing = await c.env.DB.prepare("SELECT ticker FROM etf_watchlists WHERE ticker = ? LIMIT 1")
    .bind(ticker)
    .first<{ ticker: string }>();
  if (!existing?.ticker) return c.json({ error: "ETF not found in watchlist" }, 404);
  try {
    await c.env.DB.prepare("UPDATE etf_watchlists SET source_url = ? WHERE ticker = ?")
      .bind(sourceUrl, ticker)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "source_url update failed";
    return c.json({ error: `Apply the latest D1 migration before using ETF source URL overrides. (${message})` }, 400);
  }
  await upsertAudit(c.env, "default", "ETF_SOURCE_URL_PATCH", { ticker, sourceUrl });
  return c.json({ ok: true, ticker, sourceUrl });
});

app.get("/api/admin/etf-sync-status", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  await ensureEtfCatalogCoverage(c.env);
  const limit = Math.max(10, Math.min(500, Number(c.req.query("limit") ?? 200)));
  const autoSyncLimit = Math.max(0, Math.min(3, Number(c.req.query("autoSyncLimit") ?? 1)));

  if (autoSyncLimit > 0) {
    const candidates = await c.env.DB.prepare(
      "SELECT w.ticker as ticker, w.fundName as fundName, s.last_synced_at as lastSyncedAt, s.status as status, s.error as error, s.source as source, COALESCE(s.records_count, 0) as recordsCount, COALESCE(cs.actualRecordsCount, 0) as actualRecordsCount, cs.latestConstituentUpdatedAt as latestConstituentUpdatedAt FROM (SELECT ticker, MAX(fund_name) as fundName FROM etf_watchlists GROUP BY ticker) w LEFT JOIN etf_constituent_sync_status s ON s.etf_ticker = w.ticker LEFT JOIN (SELECT etf_ticker as etfTicker, COUNT(*) as actualRecordsCount, MAX(updated_at) as latestConstituentUpdatedAt FROM etf_constituents GROUP BY etf_ticker) cs ON cs.etfTicker = w.ticker ORDER BY w.ticker ASC",
    ).all<Array<{ ticker: string; fundName: string | null } & EtfSyncStatusRow>[number]>();

    const ranked = (candidates.results ?? [])
      .map((row) => {
        const normalized = normalizeEtfSyncStatusRow({
          etfTicker: row.ticker,
          lastSyncedAt: row.lastSyncedAt,
          status: row.status,
          error: row.error,
          source: row.source,
          recordsCount: row.recordsCount,
          updatedAt: row.latestConstituentUpdatedAt ?? null,
          actualRecordsCount: row.actualRecordsCount,
          latestConstituentUpdatedAt: row.latestConstituentUpdatedAt,
        });
        const source = String(row.source ?? "").toLowerCase();
        const error = String(normalized.error ?? "");
        const fundName = String(row.fundName ?? "").toLowerCase();
        const hasError = normalized.status === "error";
        const hasNoRecords = (normalized.recordsCount ?? 0) === 0;
        const noSyncYet = !normalized.lastSyncedAt;
        const stale = isStaleDate(normalized.lastSyncedAt, 45);
        const tooManySubrequests = /too many subrequests/i.test(error);
        const looksInvesco = fundName.includes("invesco") || fundName.includes("powershares");
        let score = 0;
        if (hasError) score += 5;
        if (hasNoRecords) score += 4;
        if (noSyncYet) score += 3;
        if (stale) score += 1;
        if (tooManySubrequests) score += 4;
        if (source.startsWith("yahoo:")) score += 1;
        if (looksInvesco) score += 1;
        return { ...row, ...normalized, score };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const aTime = a.lastSyncedAt ? Date.parse(a.lastSyncedAt) : 0;
        const bTime = b.lastSyncedAt ? Date.parse(b.lastSyncedAt) : 0;
        return aTime - bTime;
      })
      .slice(0, autoSyncLimit);

    for (const row of ranked) {
      try {
        await syncEtfConstituents(c.env, row.ticker);
      } catch (error) {
        console.error("admin etf-sync-status auto-sync failed", row.ticker, error);
      }
    }
  }

  const rows = await c.env.DB.prepare(
    "SELECT w.ticker as etfTicker, s.last_synced_at as lastSyncedAt, COALESCE(s.status, 'pending') as status, s.error as error, COALESCE(s.source, 'watchlist:add') as source, COALESCE(s.records_count, 0) as recordsCount, s.updated_at as updatedAt, COALESCE(cs.actualRecordsCount, 0) as actualRecordsCount, cs.latestConstituentUpdatedAt as latestConstituentUpdatedAt FROM (SELECT DISTINCT ticker FROM etf_watchlists) w LEFT JOIN etf_constituent_sync_status s ON s.etf_ticker = w.ticker LEFT JOIN (SELECT etf_ticker as etfTicker, COUNT(*) as actualRecordsCount, MAX(updated_at) as latestConstituentUpdatedAt FROM etf_constituents GROUP BY etf_ticker) cs ON cs.etfTicker = w.ticker ORDER BY CASE WHEN COALESCE(cs.actualRecordsCount, s.records_count, 0) > 0 THEN 0 WHEN COALESCE(s.status, '') = 'error' THEN 1 ELSE 2 END, datetime(COALESCE(cs.latestConstituentUpdatedAt, s.updated_at, s.last_synced_at, '1970-01-01 00:00:00')) DESC, w.ticker ASC LIMIT ?",
  )
    .bind(limit)
    .all<EtfSyncStatusRow>();
  return c.json({ rows: (rows.results ?? []).map(normalizeEtfSyncStatusRow) });
});

app.post("/api/admin/etf/:ticker/sync", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const ticker = c.req.param("ticker").toUpperCase();
  try {
    const result = await syncEtfConstituents(c.env, ticker);
    await upsertAudit(c.env, "default", "ETF_CONSTITUENT_SYNC", { ticker, result });
    return c.json({ ok: true, ticker, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "sync failed";
    return c.json({ error: message }, 500);
  }
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

app.get("/api/gappers", async (c) => {
  await maybeRunGappersHousekeeping(c.env);
  const limit = Math.max(1, Math.min(100, Number(c.req.query("limit") ?? 25)));
  const force = c.req.query("force") === "1";
  const llmConfig = readGappersLlmOverride(c.req.raw);
  const filters = readGappersFilters(c.req.raw);
  try {
    const snapshot = await getGappersSnapshot(c.env, { force, limit, llmConfig, filters });
    return c.json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build gappers snapshot.";
    return c.json({
      id: crypto.randomUUID(),
      marketSession: "premarket",
      providerLabel: c.env.DATA_PROVIDER ?? "alpaca",
      generatedAt: new Date().toISOString(),
      rowCount: 0,
      status: "error",
      error: message,
      warning: null,
      rows: [],
    }, 500);
  }
});

app.get("/api/peer-groups/groups", async (c) => {
  const includeInactive = c.req.query("includeInactive") === "1";
  const rows = await listPeerGroups(c.env, includeInactive);
  return c.json({ rows });
});

app.get("/api/peer-groups/directory", async (c) => {
  const result = await queryPeerDirectory(c.env, {
    q: c.req.query("q"),
    groupId: c.req.query("groupId"),
    groupType: c.req.query("groupType"),
    active: c.req.query("active"),
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    offset: c.req.query("offset") ? Number(c.req.query("offset")) : undefined,
  });
  return c.json(result);
});

app.get("/api/peer-groups/ticker/:ticker", async (c) => {
  const detail = await loadPeerTickerDetail(c.env, c.req.param("ticker"));
  if (!detail) return c.json({ error: "Ticker not found." }, 404);
  return c.json(detail);
});

app.get("/api/peer-groups/ticker/:ticker/metrics", async (c) => {
  const detail = await loadPeerTickerDetail(c.env, c.req.param("ticker"));
  if (!detail) return c.json({ error: "Ticker not found." }, 404);
  const inputs = Array.from(new Map([
    [detail.symbol.ticker, { ticker: detail.symbol.ticker, exchange: detail.symbol.exchange ?? null }],
    ...detail.groups.flatMap((group) => group.members.map((member) => [
      member.ticker,
      { ticker: member.ticker, exchange: member.exchange ?? null },
    ] as const)),
  ]).values());
  const metrics = await loadPeerMetrics(c.env, inputs);
  return c.json({
    ticker: detail.symbol.ticker,
    rows: metrics.rows,
    error: metrics.error,
  });
});

app.get("/api/alerts", async (c) => {
  await maybeRunAlertsHousekeeping(c.env);
  const payload = await queryAlertsByFilters(c.env, {
    startDate: c.req.query("startDate"),
    endDate: c.req.query("endDate"),
    session: c.req.query("session"),
    limit: Number(c.req.query("limit") ?? 500),
  });
  return c.json(payload);
});

app.get("/api/alerts/unique-tickers", async (c) => {
  await maybeRunAlertsHousekeeping(c.env);
  const payload = await queryUniqueTickerDaysByFilters(c.env, {
    startDate: c.req.query("startDate"),
    endDate: c.req.query("endDate"),
    session: c.req.query("session"),
    limit: Number(c.req.query("limit") ?? 150),
  });
  return c.json(payload);
});

app.get("/api/alerts/news", async (c) => {
  const ticker = (c.req.query("ticker") ?? "").trim().toUpperCase();
  const tradingDay = (c.req.query("tradingDay") ?? "").trim();
  if (!/^[A-Z.\-^]{1,20}$/.test(ticker)) return c.json({ error: "Valid ticker is required." }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDay)) return c.json({ error: "Valid tradingDay is required." }, 400);
  const rows = await c.env.DB.prepare(
    "SELECT id, ticker, trading_day as tradingDay, headline, source, url, published_at as publishedAt, snippet, fetched_at as fetchedAt FROM ticker_news WHERE ticker = ? AND trading_day = ? ORDER BY datetime(COALESCE(published_at, fetched_at)) DESC LIMIT 3",
  )
    .bind(ticker, tradingDay)
    .all();
  return c.json({ ticker, tradingDay, rows: rows.results ?? [] });
});

app.get("/api/ticker/:ticker/news", async (c) => {
  const ticker = c.req.param("ticker").trim().toUpperCase();
  const tradingDay = (c.req.query("tradingDay") ?? latestUsSessionAsOfDate(new Date())).trim();
  const limit = Math.max(1, Math.min(10, Number(c.req.query("limit") ?? 5)));
  if (!/^[A-Z.\-^]{1,20}$/.test(ticker)) return c.json({ error: "Valid ticker is required." }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDay)) return c.json({ error: "Valid tradingDay is required." }, 400);
  try {
    const payload = await fetchTickerNews(c.env, ticker, tradingDay, limit);
    return c.json({ ticker, tradingDay, rows: payload.rows, providersTried: payload.providersTried });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to load ticker news." }, 500);
  }
});

app.get("/api/scans", async (c) => {
  await maybeRunScansPageHousekeeping(c.env);
  const presetId = c.req.query("presetId") ?? null;
  const preset = presetId ? await loadScanPreset(c.env, presetId) : await loadDefaultScanPreset(c.env);
  if (!preset) {
    return c.json({
      id: crypto.randomUUID(),
      presetId: "",
      presetName: "",
      providerLabel: "TradingView Screener (Python)",
      generatedAt: new Date().toISOString(),
      rowCount: 0,
      status: "empty",
      error: "No scan preset configured.",
      rows: [],
    });
  }
  const snapshot = await loadLatestScansSnapshot(c.env, preset.id);
  return c.json(snapshot ?? {
    id: crypto.randomUUID(),
    presetId: preset.id,
    presetName: preset.name,
    providerLabel: "TradingView Screener (Python)",
    generatedAt: new Date().toISOString(),
    rowCount: 0,
    status: "empty",
    error: null,
    rows: [],
  });
});

app.get("/api/scans/presets", async (c) => {
  await maybeRunScansPageHousekeeping(c.env);
  const rows = await listScanPresets(c.env);
  return c.json({ rows });
});

app.get("/api/scans/compiled", async (c) => {
  await maybeRunScansPageHousekeeping(c.env);
  const presetIds = (c.req.query("presetIds") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return c.json(await loadCompiledScansSnapshot(c.env, presetIds));
});

app.get("/api/scans/compiled/export.txt", async (c) => {
  await maybeRunScansPageHousekeeping(c.env);
  const presetIds = (c.req.query("presetIds") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const dateSuffix = (c.req.query("dateSuffix") ?? "").trim() || new Date().toISOString().slice(0, 10);
  const payload = await loadCompiledScansSnapshot(c.env, presetIds);
  const formattedDate = /^\d{4}-\d{2}-\d{2}$/.test(dateSuffix)
    ? dateSuffix.slice(5)
    : dateSuffix;
  const safePresetNames = payload.presetNames
    .map((name) => name.replace(/[<>:"/\\|?*]+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const fileName = safePresetNames.length > 0
    ? `compiled-scans-${formattedDate}-[${safePresetNames.join(", ")}].txt`
    : `compiled-scans-${formattedDate}.txt`;
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${fileName}"`);
  return c.body(payload.rows.map((row) => row.ticker).join("\n"));
});

app.post("/api/admin/scans/refresh", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  await maybeRunScansPageHousekeeping(c.env);
  const payload = scanRefreshSchema.parse(await c.req.json().catch(() => ({})));
  try {
    const snapshot = await refreshScansSnapshot(c.env, payload.presetId ?? null);
    return c.json({ ok: true, snapshot });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to refresh scans." }, 500);
  }
});

app.post("/api/admin/scans/presets", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  try {
    const payload = scanPresetCreateSchema.parse(await c.req.json());
    const preset = await upsertScanPreset(c.env, payload);
    return c.json({ ok: true, preset });
  } catch (error) {
    if (error instanceof ZodError) {
      return c.json({ error: error.issues[0]?.message ?? "Invalid scan preset payload." }, 400);
    }
    return c.json({ error: error instanceof Error ? error.message : "Failed to save scan preset." }, 500);
  }
});

app.patch("/api/admin/scans/presets/:presetId", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const presetId = c.req.param("presetId");
  const existing = await loadScanPreset(c.env, presetId);
  if (!existing) return c.json({ error: "Scan preset not found." }, 404);
  try {
    const payload = scanPresetPatchSchema.parse(await c.req.json());
    const preset = await upsertScanPreset(c.env, {
      id: presetId,
      name: payload.name ?? existing.name,
      isDefault: payload.isDefault ?? existing.isDefault,
      isActive: payload.isActive ?? existing.isActive,
      rules: payload.rules ?? existing.rules,
      sortField: payload.sortField ?? existing.sortField,
      sortDirection: payload.sortDirection ?? existing.sortDirection,
      rowLimit: payload.rowLimit ?? existing.rowLimit,
    });
    return c.json({ ok: true, preset });
  } catch (error) {
    if (error instanceof ZodError) {
      return c.json({ error: error.issues[0]?.message ?? "Invalid scan preset payload." }, 400);
    }
    return c.json({ error: error instanceof Error ? error.message : "Failed to save scan preset." }, 500);
  }
});

app.delete("/api/admin/scans/presets/:presetId", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  try {
    await deleteScanPreset(c.env, c.req.param("presetId"));
    return c.json({ ok: true, presetId: c.req.param("presetId") });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to delete scan preset." }, 400);
  }
});

app.get("/api/watchlist-compiler/sets", async (c) => {
  await maybeRunScanningHousekeeping(c.env);
  const rows = await listWatchlistSets(c.env, c.req.query("includeInactive") === "1");
  return c.json({ rows });
});

app.get("/api/watchlist-compiler/sets/:id", async (c) => {
  await maybeRunScanningHousekeeping(c.env);
  const detail = await loadWatchlistSet(c.env, c.req.param("id"));
  if (!detail) return c.json({ error: "Watchlist set not found." }, 404);
  return c.json(detail);
});

app.get("/api/watchlist-compiler/sets/:id/runs", async (c) => {
  await maybeRunScanningHousekeeping(c.env);
  const rows = await listWatchlistSetRuns(c.env, c.req.param("id"), Number(c.req.query("limit") ?? 25));
  return c.json({ rows });
});

app.get("/api/watchlist-compiler/sets/:id/compiled", async (c) => {
  await maybeRunScanningHousekeeping(c.env);
  const result = await loadWatchlistCompiledRows(c.env, c.req.param("id"), c.req.query("runId") ?? null);
  return c.json({ set: result.set, runId: result.runId, rows: result.rows });
});

app.get("/api/watchlist-compiler/sets/:id/unique", async (c) => {
  await maybeRunScanningHousekeeping(c.env);
  const result = await loadWatchlistUniqueRows(c.env, c.req.param("id"), c.req.query("runId") ?? null);
  return c.json({ set: result.set, runId: result.runId, rows: result.rows });
});

app.get("/api/watchlist-compiler/sets/:id/export.txt", async (c) => {
  await maybeRunScanningHousekeeping(c.env);
  const mode = c.req.query("mode") === "compiled" ? "compiled" : "unique";
  const runId = c.req.query("runId") ?? null;
  const dateSuffix = c.req.query("dateSuffix");
  const payload = mode === "compiled"
    ? await loadWatchlistCompiledRows(c.env, c.req.param("id"), runId)
    : await loadWatchlistUniqueRows(c.env, c.req.param("id"), runId);
  const tickers = mode === "compiled"
    ? payload.rows.map((row: any) => row.ticker)
    : payload.rows.map((row: any) => row.ticker);
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${resolveExportFileName({ slug: payload.set.slug, mode, extension: "txt", dateSuffix })}"`);
  return c.body(tickersToTxt(tickers));
});

app.get("/api/watchlist-compiler/sets/:id/export.csv", async (c) => {
  await maybeRunScanningHousekeeping(c.env);
  const mode = c.req.query("mode") === "compiled" ? "compiled" : "unique";
  const runId = c.req.query("runId") ?? null;
  const dateSuffix = c.req.query("dateSuffix");
  const payload = mode === "compiled"
    ? await loadWatchlistCompiledRows(c.env, c.req.param("id"), runId)
    : await loadWatchlistUniqueRows(c.env, c.req.param("id"), runId);
  const tickers = mode === "compiled"
    ? payload.rows.map((row: any) => row.ticker)
    : payload.rows.map((row: any) => row.ticker);
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${resolveExportFileName({ slug: payload.set.slug, mode, extension: "csv", dateSuffix })}"`);
  return c.body(tickersToSingleColumnCsv(tickers));
});

app.get("/api/admin/config", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const configId = c.req.query("configId") ?? "default";
  try {
    await ensureOverviewCatalogCoverage(c.env);
    const config = await loadConfig(c.env, configId);
    return c.json(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load admin config.";
    console.error("admin config load failed", { configId, error });
    return c.json({ error: message }, 500);
  }
});

app.get("/api/admin/watchlist-compiler/sets", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const rows = await listWatchlistSets(c.env, true);
  return c.json({ rows });
});

app.post("/api/admin/watchlist-compiler/sets", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const payload = watchlistSetCreateSchema.parse(await c.req.json());
  const created = await createWatchlistSet(c.env, payload);
  await upsertAudit(c.env, "default", "WATCHLIST_SET_CREATE", { id: created.id, payload });
  return c.json({ ok: true, id: created.id });
});

app.patch("/api/admin/watchlist-compiler/sets/:id", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const payload = watchlistSetPatchSchema.parse(await c.req.json());
  await updateWatchlistSet(c.env, c.req.param("id"), payload);
  await upsertAudit(c.env, "default", "WATCHLIST_SET_PATCH", { id: c.req.param("id"), payload });
  return c.json({ ok: true, id: c.req.param("id") });
});

app.delete("/api/admin/watchlist-compiler/sets/:id", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  await deleteWatchlistSet(c.env, c.req.param("id"));
  await upsertAudit(c.env, "default", "WATCHLIST_SET_DELETE", { id: c.req.param("id") });
  return c.json({ ok: true, id: c.req.param("id") });
});

app.post("/api/admin/watchlist-compiler/sets/:id/sources", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const payload = watchlistSourceCreateSchema.parse(await c.req.json());
  const created = await createWatchlistSource(c.env, c.req.param("id"), payload);
  await upsertAudit(c.env, "default", "WATCHLIST_SOURCE_CREATE", { setId: c.req.param("id"), id: created.id, payload });
  return c.json({ ok: true, id: created.id });
});

app.patch("/api/admin/watchlist-compiler/sources/:id", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const payload = watchlistSourcePatchSchema.parse(await c.req.json());
  await updateWatchlistSource(c.env, c.req.param("id"), payload);
  await upsertAudit(c.env, "default", "WATCHLIST_SOURCE_PATCH", { id: c.req.param("id"), payload });
  return c.json({ ok: true, id: c.req.param("id") });
});

app.delete("/api/admin/watchlist-compiler/sources/:id", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  await deleteWatchlistSource(c.env, c.req.param("id"));
  await upsertAudit(c.env, "default", "WATCHLIST_SOURCE_DELETE", { id: c.req.param("id") });
  return c.json({ ok: true, id: c.req.param("id") });
});

app.post("/api/admin/watchlist-compiler/sets/:id/compile", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  await maybeRunScanningHousekeeping(c.env);
  const result = await compileWatchlistSet(c.env, c.req.param("id"));
  await upsertAudit(c.env, "default", "WATCHLIST_SET_COMPILE", { id: c.req.param("id"), runId: result.run.id });
  return c.json({ ok: true, run: result.run, set: result.set });
});

app.get("/api/admin/peer-groups", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const rows = await listPeerGroups(c.env, true);
  return c.json({ rows });
});

app.post("/api/admin/peer-groups", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const payload = peerGroupCreateSchema.parse(await c.req.json());
  const created = await createPeerGroup(c.env, payload);
  await upsertAudit(c.env, "default", "PEER_GROUP_CREATE", { id: created.id, payload });
  return c.json({ ok: true, id: created.id });
});

app.patch("/api/admin/peer-groups/:groupId", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const groupId = c.req.param("groupId");
  const payload = peerGroupPatchSchema.parse(await c.req.json());
  await updatePeerGroup(c.env, groupId, payload);
  await upsertAudit(c.env, "default", "PEER_GROUP_PATCH", { groupId, payload });
  return c.json({ ok: true, id: groupId });
});

app.delete("/api/admin/peer-groups/:groupId", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const groupId = c.req.param("groupId");
  await deletePeerGroup(c.env, groupId);
  await upsertAudit(c.env, "default", "PEER_GROUP_DELETE", { groupId });
  return c.json({ ok: true, id: groupId });
});

app.get("/api/admin/peer-groups/ticker-search", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const q = String(c.req.query("q") ?? "").trim();
  if (!q) return c.json({ rows: [] });
  const qUpper = q.toUpperCase();
  const rows = await c.env.DB.prepare(
    `SELECT ticker, name, exchange, sector, industry
     FROM symbols
     WHERE (asset_class IS NULL OR asset_class IN ('equity', 'stock')) AND (ticker = ? OR ticker LIKE ? OR name LIKE ? COLLATE NOCASE)
     ORDER BY
       CASE
         WHEN ticker = ? THEN 0
         WHEN ticker LIKE ? THEN 1
         ELSE 2
       END,
       ticker ASC
     LIMIT 25`,
  )
    .bind(qUpper, `${qUpper}%`, `%${q}%`, qUpper, `${qUpper}%`)
    .all<{ ticker: string; name: string | null; exchange: string | null; sector: string | null; industry: string | null }>();
  const existing = rows.results ?? [];
  if (existing.length === 0 && /^[A-Z.\-^]{1,20}$/.test(qUpper)) {
    const resolved = await resolveTickerMeta(qUpper, c.env);
    if (resolved) {
      return c.json({
        rows: [{
          ticker: resolved.ticker,
          name: resolved.name,
          exchange: resolved.exchange,
          sector: null,
          industry: null,
        }],
      });
    }
  }
  return c.json({ rows: existing });
});

app.get("/api/admin/peer-groups/ticker/:ticker", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const detail = await loadPeerTickerDetail(c.env, c.req.param("ticker"));
  if (!detail) {
    const resolved = await resolveTickerMeta(c.req.param("ticker"), c.env);
    if (!resolved) return c.json({ error: "Ticker not found." }, 404);
    return c.json({
      symbol: {
        ticker: resolved.ticker,
        name: resolved.name,
        exchange: resolved.exchange,
        sector: null,
        industry: null,
        sharesOutstanding: null,
      },
      groups: [],
    });
  }
  return c.json(detail);
});

app.post("/api/admin/peer-groups/:groupId/members", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const groupId = c.req.param("groupId");
  const payload = peerMembershipCreateSchema.parse(await c.req.json());
  const resolved = await resolveTickerMeta(payload.ticker, c.env);
  if (!resolved) return c.json({ error: "Ticker not found." }, 400);
  await c.env.DB.prepare(
    `INSERT INTO symbols (ticker, name, exchange, asset_class, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(ticker) DO UPDATE SET
       name = COALESCE(excluded.name, symbols.name),
       exchange = COALESCE(excluded.exchange, symbols.exchange),
       asset_class = COALESCE(symbols.asset_class, excluded.asset_class),
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(resolved.ticker, resolved.name, resolved.exchange ?? null, resolved.assetClass)
    .run();
  await upsertTickerPeerMembership(c.env, {
    ticker: resolved.ticker,
    peerGroupId: groupId,
    source: payload.source,
    confidence: payload.confidence ?? null,
  });
  await upsertAudit(c.env, "default", "PEER_GROUP_MEMBER_ADD", { groupId, ticker: resolved.ticker, payload });
  return c.json({ ok: true, ticker: resolved.ticker });
});

app.delete("/api/admin/peer-groups/:groupId/members/:ticker", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const groupId = c.req.param("groupId");
  const ticker = c.req.param("ticker");
  await removeTickerPeerMembership(c.env, groupId, ticker);
  await upsertAudit(c.env, "default", "PEER_GROUP_MEMBER_DELETE", { groupId, ticker });
  return c.json({ ok: true, ticker: ticker.toUpperCase() });
});

app.post("/api/admin/peer-groups/seed", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const payload = peerSeedSchema.parse(await c.req.json());
  const result = await seedPeerGroupForTicker(c.env, payload.ticker);
  await upsertAudit(c.env, "default", "PEER_GROUP_SEED", result);
  return c.json({ ok: true, ...result });
});

app.post("/api/admin/peer-groups/bootstrap", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const payload = peerBootstrapSchema.parse(await c.req.json().catch(() => ({})));
  const candidates = await listPeerBootstrapCandidates(c.env, payload);
  const rows: Array<{
    ticker: string;
    ok: boolean;
    groupId?: string;
    insertedTickers?: string[];
    sourceBreakdown?: Record<string, number>;
    error?: string;
  }> = [];
  for (const candidate of candidates) {
    try {
      const result = await seedPeerGroupForTicker(c.env, candidate.ticker, {
        providerMode: payload.providerMode,
        enrichPeers: payload.enrichPeers,
      });
      rows.push({
        ticker: candidate.ticker,
        ok: true,
        groupId: result.groupId,
        insertedTickers: result.insertedTickers,
        sourceBreakdown: result.sourceBreakdown,
      });
      await upsertAudit(c.env, "default", "PEER_GROUP_BOOTSTRAP_SEED", result);
    } catch (error) {
      rows.push({
        ticker: candidate.ticker,
        ok: false,
        error: error instanceof Error ? error.message : "Peer bootstrap seed failed.",
      });
    }
  }
  return c.json({
    ok: true,
    requested: payload.limit,
    attempted: candidates.length,
    rows,
  });
});

app.post("/api/admin/peer-groups/normalize-labels", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const payload = peerNormalizeSchema.parse(await c.req.json().catch(() => ({})));
  const result = await normalizeSeededPeerGroupLabels(c.env, payload);
  await upsertAudit(c.env, "default", "PEER_GROUP_NORMALIZE_LABELS", result);
  return c.json({ ok: true, ...result });
});

app.post("/api/admin/gappers/refresh", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const limit = Math.max(1, Math.min(100, Number(c.req.query("limit") ?? 25)));
  const llmConfig = readGappersLlmOverride(c.req.raw);
  const filters = readGappersFilters(c.req.raw);
  try {
    const snapshot = await refreshGappersSnapshot(c.env, limit, llmConfig, filters);
    return c.json({ ok: true, snapshot });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to refresh gappers." }, 500);
  }
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

app.get("/api/admin/etf-sync-diagnostics", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  await ensureEtfCatalogCoverage(c.env);
  const ticker = (c.req.query("ticker") ?? "TAN").trim().toUpperCase();
  if (!/^[A-Z.\-^]{1,20}$/.test(ticker)) {
    return c.json({ error: "Valid ticker is required." }, 400);
  }

  try {
    await c.env.DB.prepare("SELECT 1 as ok").first();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Database connectivity check failed";
    return c.json(
      {
        backendRevision: API_REVISION,
        serverTimeUtc: new Date().toISOString(),
        dataProvider: c.env.DATA_PROVIDER ?? "alpaca",
        ticker,
        db: { ok: false, error: message },
      },
      500,
    );
  }

  const watchlists = await (async () => {
    try {
      return await c.env.DB.prepare(
        "SELECT list_type as listType, parent_sector as parentSector, industry, fund_name as fundName, source_url as sourceUrl FROM etf_watchlists WHERE ticker = ? ORDER BY list_type ASC",
      )
        .bind(ticker)
        .all<{ listType: string; parentSector: string | null; industry: string | null; fundName: string | null; sourceUrl: string | null }>();
    } catch {
      return await c.env.DB.prepare(
        "SELECT list_type as listType, parent_sector as parentSector, industry, fund_name as fundName FROM etf_watchlists WHERE ticker = ? ORDER BY list_type ASC",
      )
        .bind(ticker)
        .all<{ listType: string; parentSector: string | null; industry: string | null; fundName: string | null }>();
    }
  })();
  const sourceUrl = await loadEtfSourceUrl(c.env, ticker);
  const syncStatusRaw = await c.env.DB.prepare(
    "SELECT s.etf_ticker as etfTicker, s.last_synced_at as lastSyncedAt, s.status, s.error, s.source, s.records_count as recordsCount, s.updated_at as updatedAt, COALESCE(cs.actualRecordsCount, 0) as actualRecordsCount, cs.latestConstituentUpdatedAt as latestConstituentUpdatedAt FROM etf_constituent_sync_status s LEFT JOIN (SELECT etf_ticker as etfTicker, COUNT(*) as actualRecordsCount, MAX(updated_at) as latestConstituentUpdatedAt FROM etf_constituents GROUP BY etf_ticker) cs ON cs.etfTicker = s.etf_ticker WHERE s.etf_ticker = ?",
  )
    .bind(ticker)
    .first<EtfSyncStatusRow>();
  const constituentSummary = await c.env.DB.prepare(
    "SELECT COUNT(*) as count, MAX(as_of_date) as latestAsOfDate, MAX(updated_at) as latestUpdatedAt FROM etf_constituents WHERE etf_ticker = ?",
  )
    .bind(ticker)
    .first<{ count: number; latestAsOfDate: string | null; latestUpdatedAt: string | null }>();
  const syncStatus = syncStatusRaw
    ? normalizeEtfSyncStatusRow(syncStatusRaw)
    : ((constituentSummary?.count ?? 0) > 0
      ? {
          etfTicker: ticker,
          lastSyncedAt: constituentSummary?.latestUpdatedAt ?? null,
          status: "ok",
          error: null,
          source: null,
          recordsCount: constituentSummary?.count ?? 0,
          updatedAt: constituentSummary?.latestUpdatedAt ?? null,
        }
      : null);
  const topConstituents = await c.env.DB.prepare(
    "SELECT constituent_ticker as ticker, constituent_name as name, weight, as_of_date as asOfDate, source, updated_at as updatedAt FROM etf_constituents WHERE etf_ticker = ? ORDER BY weight DESC, constituent_ticker ASC LIMIT 10",
  )
    .bind(ticker)
    .all<{
      ticker: string;
      name: string | null;
      weight: number | null;
      asOfDate: string | null;
      source: string | null;
      updatedAt: string | null;
    }>();

  return c.json({
    backendRevision: API_REVISION,
    serverTimeUtc: new Date().toISOString(),
    dataProvider: c.env.DATA_PROVIDER ?? "alpaca",
    ticker,
    db: { ok: true, error: null },
    watchlists: (watchlists.results ?? []).map((row: any) => ({ ...row, sourceUrl: row.sourceUrl ?? null })),
    sourceUrl,
    syncStatus: syncStatus ?? null,
    constituentSummary: {
      count: constituentSummary?.count ?? 0,
      latestAsOfDate: constituentSummary?.latestAsOfDate ?? null,
      latestUpdatedAt: constituentSummary?.latestUpdatedAt ?? null,
    },
    topConstituents: topConstituents.results ?? [],
  });
});

app.post("/api/admin/alerts/ingest-email", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: InboundEmailPayload;
    emails?: InboundEmailPayload[];
    cleanup?: boolean;
  };
  const emails = Array.isArray(body.emails) ? body.emails : body.email ? [body.email] : [];
  if (emails.length === 0) {
    return c.json({ error: "Provide `email` or `emails` payload." }, 400);
  }
  const batch = await ingestTradingViewAlertEmailsBatch(c.env, emails);
  const cleanup = body.cleanup ? await cleanupOldAlertsData(c.env, 30) : null;
  return c.json({
    ok: true,
    ...batch,
    cleanup,
  });
});

app.post("/api/admin/alerts/reconcile", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { maxEmails?: number; cleanup?: boolean };
  const maxEmails = Math.max(1, Math.min(200, Number(body.maxEmails ?? 50)));
  const reconcile = await reconcileAlertsFromMailboxAdapters(c.env, maxEmails);
  const cleanup = body.cleanup !== false ? await cleanupOldAlertsData(c.env, 30) : null;
  return c.json({ ok: true, reconcile, cleanup });
});

app.post("/api/admin/run-eod", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const date = c.req.query("date") ?? latestUsSessionAsOfDate(new Date());
  const configId = c.req.query("configId") ?? "default";
  try {
    const result = await computeAndStoreSnapshot(c.env, date, configId);
    return c.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "run-eod failed";
    console.error("admin run-eod failed", { date, configId, error });
    return c.json({ error: message }, 500);
  }
});

app.post("/api/admin/etf-sync-backfill", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  await ensureEtfCatalogCoverage(c.env);
  const body = (await c.req.json().catch(() => ({}))) as { limit?: number };
  // Keep this low to avoid Cloudflare subrequest caps in one request.
  const limit = Math.max(1, Math.min(5, Number(body.limit ?? 3)));
  const rows = await c.env.DB.prepare(
    "SELECT w.ticker as ticker, s.last_synced_at as lastSyncedAt, s.status as status, s.records_count as recordsCount FROM etf_watchlists w LEFT JOIN etf_constituent_sync_status s ON s.etf_ticker = w.ticker ORDER BY w.ticker ASC",
  ).all<{ ticker: string; lastSyncedAt: string | null; status: string | null; recordsCount: number | null }>();
  const candidates = (rows.results ?? [])
    .filter((r) => (r.recordsCount ?? 0) === 0 || r.status === "error" || isStaleDate(r.lastSyncedAt, 45))
    .slice(0, limit);

  let ok = 0;
  const failed: Array<{ ticker: string; error: string }> = [];
  for (const row of candidates) {
    try {
      await syncEtfConstituents(c.env, row.ticker);
      ok += 1;
    } catch (error) {
      failed.push({ ticker: row.ticker, error: error instanceof Error ? error.message : "sync failed" });
    }
  }

  return c.json({
    ok: true,
    attempted: candidates.length,
    synced: ok,
    failed,
  });
});

app.post("/api/admin/run-breadth", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const date = c.req.query("date");
  try {
    const result = await recomputeBreadthFromStoredBars(c.env, date);
    return c.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "run-breadth failed";
    console.error("admin run-breadth failed", { date, error });
    return c.json({ error: message }, 500);
  }
});

app.post("/api/admin/refresh-page", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { page?: string; ticker?: string | null };
  const rawPage = String(body.page ?? "").trim().toLowerCase();
  const page = (rawPage || "overview") as RefreshPage;
  if (!["overview", "breadth", "sectors", "thirteenf", "admin", "ticker", "alerts", "scans", "watchlist-compiler", "gappers"].includes(page)) {
    return c.json({ error: "Unsupported page key." }, 400);
  }
  try {
    const result = await refreshPageScopedData(c.env, page, body.ticker ?? null);
    return c.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "page refresh failed";
    console.error("admin refresh-page failed", { page, error });
    return c.json({ error: message }, 500);
  }
});

app.patch("/api/admin/config", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const payload = configPatchSchema.parse(await c.req.json());
  await c.env.DB.prepare(
    "UPDATE dashboard_configs SET name = ?, timezone = ?, eod_run_local_time = ?, eod_run_time_label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(payload.name, payload.timezone, payload.eodRunLocalTime, payload.eodRunTimeLabel, payload.id)
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

  let hasProviderData = false;
  let providerError: string | null = null;
  try {
    const provider = getProvider(c.env);
    const end = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - 45 * 86400_000).toISOString().slice(0, 10);
    const rows = await provider.getDailyBars([resolved.ticker], start, end);
    hasProviderData = rows.some((r) => r.ticker.toUpperCase() === resolved.ticker.toUpperCase());
  } catch (error) {
    providerError = error instanceof Error ? error.message : "provider request failed";
  }
  if (!hasProviderData) {
    const detail = providerError ? ` (${providerError})` : "";
    return c.json(
      { error: `Ticker '${payload.ticker}' resolved, but no recent market data was returned by the active provider${detail}.` },
      400,
    );
  }

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

app.patch("/api/admin/item/:itemId", async (c) => {
  if (!isAuthed(c.req.raw, c.env)) return c.json({ error: "Unauthorized" }, 401);
  const itemId = c.req.param("itemId");
  const payload = itemPatchSchema.parse(await c.req.json());
  const nextDisplayName = payload.displayName?.trim() || null;
  const existing = await c.env.DB.prepare(
    "SELECT display_name as displayName FROM dashboard_items WHERE id = ? LIMIT 1",
  )
    .bind(itemId)
    .first<{ displayName: string | null }>();
  if (!existing) return c.json({ error: "Item not found." }, 404);

  const updated = (existing.displayName ?? null) !== nextDisplayName;
  if (updated) {
    await c.env.DB.prepare(
      "UPDATE dashboard_items SET display_name = ? WHERE id = ?",
    )
      .bind(nextDisplayName, itemId)
      .run();
    await upsertAudit(c.env, "default", "ITEM_PATCH", { itemId, payload });
    await refreshSnapshotSafe(c.env);
  }
  return c.json({ ok: true, itemId, updated });
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

async function syncMonthlyEtfSlice(env: Env): Promise<void> {
  // Process only a small stale slice per scheduled run to stay under worker subrequest budgets.
  const maxPerRun = 3;
  const staleDays = 28;
  const staleRows = await env.DB.prepare(
    "SELECT w.ticker as ticker, s.last_synced_at as lastSyncedAt FROM etf_watchlists w LEFT JOIN etf_constituent_sync_status s ON s.etf_ticker = w.ticker WHERE s.last_synced_at IS NULL OR (julianday('now') - julianday(s.last_synced_at)) >= ? ORDER BY CASE WHEN s.last_synced_at IS NULL THEN 0 ELSE 1 END, datetime(s.last_synced_at) ASC, w.ticker ASC LIMIT ?",
  )
    .bind(staleDays, maxPerRun)
    .all<{ ticker: string; lastSyncedAt: string | null }>();
  const selected = staleRows.results ?? [];
  for (const row of selected) {
    try {
      await syncEtfConstituents(env, row.ticker);
    } catch (error) {
      console.error("monthly etf constituent sync failed", row.ticker, error);
    }
  }
}

export default {
  fetch: app.fetch,
  email: async (message: any, env: Env): Promise<void> => {
    await handleInboundTradingViewEmail(message, env);
  },
  scheduled: async (event: ScheduledEvent, env: Env): Promise<void> => {
    await maybeRunAlertsHousekeeping(env);
    await maybeRunScansPageHousekeeping(env);
    await maybeRunScanningHousekeeping(env);
    await maybeRunGappersHousekeeping(env);
    const now = new Date(event.scheduledTime || Date.now());
    await runDueWatchlistCompiles(env, now);
    const defaultConfig = await loadDefaultConfigRow(env);
    const timezone = defaultConfig?.timezone ?? env.APP_TIMEZONE ?? "Australia/Melbourne";
    const refreshTime = defaultConfig?.eodRunLocalTime ?? "08:15";
    if (!shouldRunScheduledEod(now, timezone, refreshTime)) return;

    const expectedAsOf = latestUsSessionAsOfDate(now);
    const latestOverview = await env.DB.prepare(
      "SELECT as_of_date as asOfDate FROM snapshots_meta WHERE config_id = ? ORDER BY generated_at DESC LIMIT 1",
    )
      .bind(defaultConfig?.id ?? "default")
      .first<{ asOfDate: string | null }>();
    const latestBreadth = await env.DB.prepare(
      "SELECT as_of_date as asOfDate FROM breadth_snapshots ORDER BY generated_at DESC LIMIT 1",
    ).first<{ asOfDate: string | null }>();
    if (latestOverview?.asOfDate !== expectedAsOf || latestBreadth?.asOfDate !== expectedAsOf) {
      await computeAndStoreSnapshot(env, expectedAsOf, defaultConfig?.id ?? "default");
    }
    await syncMonthlyEtfSlice(env);
  },
};
