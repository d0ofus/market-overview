import type { DashboardConfigPayload, Env } from "./types";

const uid = () => crypto.randomUUID();
const defaultColumns = ["ticker", "name", "price", "1D", "1W", "3M", "6M", "YTD", "sparkline"];
const DEFAULT_REFRESH_TIME = "08:15";
const DEFAULT_REFRESH_TIMEZONE = "Australia/Melbourne";
const SYMBOL_LOOKUP_CHUNK_SIZE = 50;
const OVERVIEW_SMA_PILOT_GROUPS = new Set([
  "g-crypto",
  "g-thematic",
  "g-metals-energy",
  "g-global",
  "g-country",
  "g-market-leaders",
]);
const OVERVIEW_SMA_COLUMNS = ["20SMA", "50SMA", "200SMA"] as const;
const OVERVIEW_RS_AUTO_GROUPS = new Set([
  "g-crypto",
  "g-metals-energy",
  "g-global",
  "g-country",
  "g-market-leaders",
  "g-thematic",
  "g-sector-etf",
  "g-sector-etf-eqwt",
]);
const OVERVIEW_SPARKLINE_BEFORE_PRICE_GROUPS = new Set(["g-sector-etf", "g-sector-etf-eqwt"]);

function normalizeOverviewColumns(columns: string[]): string[] {
  const includeTicker = columns.includes("ticker");
  const includeName = columns.includes("name");
  const includePrice = columns.includes("price");
  const includeSparkline = columns.includes("sparkline");
  const includeRelativeStrength = columns.includes("relativeStrength30dVsSpy");
  const include20Sma = columns.includes("20SMA");
  const include50Sma = columns.includes("50SMA");
  const include200Sma = columns.includes("200SMA");
  const normalized = [
    ...(includeTicker ? ["ticker"] : []),
    ...(includeName ? ["name"] : []),
    ...(includePrice ? ["price"] : []),
    "1D",
    "1W",
    "3M",
    "6M",
    "YTD",
    ...(includeSparkline ? ["sparkline"] : []),
    ...(includeRelativeStrength ? ["relativeStrength30dVsSpy"] : []),
    ...(include20Sma ? ["20SMA"] : []),
    ...(include50Sma ? ["50SMA"] : []),
    ...(include200Sma ? ["200SMA"] : []),
  ];
  return Array.from(new Set(normalized));
}

function withOverviewPilotColumns(
  groupId: string,
  items: Array<{ ticker: string }>,
  columns: string[],
): string[] {
  const hasEligibleRow = OVERVIEW_RS_AUTO_GROUPS.has(groupId) && items.length > 0;
  if (!hasEligibleRow || columns.includes("relativeStrength30dVsSpy")) {
    return columns;
  }
  return [...columns, "relativeStrength30dVsSpy"];
}

function withOverviewSmaPilotColumns(groupId: string, columns: string[]): string[] {
  if (!OVERVIEW_SMA_PILOT_GROUPS.has(groupId)) return columns;
  const next = [...columns];
  for (const column of OVERVIEW_SMA_COLUMNS) {
    if (!next.includes(column)) next.push(column);
  }
  return next;
}

function reorderOverviewColumnsForGroup(groupId: string, columns: string[]): string[] {
  if (!OVERVIEW_SPARKLINE_BEFORE_PRICE_GROUPS.has(groupId)) return columns;

  const remaining = columns.filter((column) => column !== "sparkline" && column !== "relativeStrength30dVsSpy");
  const nameIndex = remaining.indexOf("name");
  const insertAt = nameIndex >= 0 ? nameIndex + 1 : 0;
  const visualColumns = [
    ...(columns.includes("sparkline") ? ["sparkline"] : []),
    ...(columns.includes("relativeStrength30dVsSpy") ? ["relativeStrength30dVsSpy"] : []),
  ];
  if (visualColumns.length === 0) return columns;

  const reordered = [...remaining];
  reordered.splice(insertAt, 0, ...visualColumns);
  return reordered;
}

function buildRefreshLabel(localTime: string | null | undefined, timezone: string | null | undefined): string {
  const safeTime = typeof localTime === "string" && /^\d{2}:\d{2}$/.test(localTime.trim()) ? localTime.trim() : DEFAULT_REFRESH_TIME;
  const safeTimezone = timezone?.trim() || DEFAULT_REFRESH_TIMEZONE;
  return `${safeTime} ${safeTimezone} (prev US close)`;
}

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function resolveConfigRow(
  env: Env,
  configId: string,
): Promise<{ id: string; name: string; timezone: string; eodRunLocalTime: string; eodRunTimeLabel: string }> {
  const queryWithRefreshCols =
    "SELECT id, name, timezone, eod_run_local_time as eodRunLocalTime, eod_run_time_label as eodRunTimeLabel FROM dashboard_configs WHERE id = ? LIMIT 1";
  const queryLegacyCols =
    "SELECT id, name, timezone, eod_run_time_label as eodRunTimeLabel FROM dashboard_configs WHERE id = ? LIMIT 1";

  try {
    const byId = await env.DB.prepare(queryWithRefreshCols)
      .bind(configId)
      .first<{ id: string; name: string; timezone: string; eodRunLocalTime: string; eodRunTimeLabel: string }>();
    if (byId) return byId;
  } catch {
    // Fall through to legacy shape.
  }

  try {
    const legacyById = await env.DB.prepare(queryLegacyCols)
      .bind(configId)
      .first<{ id: string; name: string; timezone: string; eodRunTimeLabel: string }>();
    if (legacyById) {
      return {
        ...legacyById,
        eodRunLocalTime: DEFAULT_REFRESH_TIME,
        eodRunTimeLabel: buildRefreshLabel(DEFAULT_REFRESH_TIME, legacyById.timezone),
      };
    }
  } catch {
    // Continue to non-id fallback lookups.
  }

  const fallbackCandidates = [
    "SELECT id, name, timezone, eod_run_local_time as eodRunLocalTime, eod_run_time_label as eodRunTimeLabel FROM dashboard_configs WHERE is_default = 1 LIMIT 1",
    "SELECT id, name, timezone, eod_run_local_time as eodRunLocalTime, eod_run_time_label as eodRunTimeLabel FROM dashboard_configs ORDER BY id ASC LIMIT 1",
    "SELECT id, name, timezone, eod_run_time_label as eodRunTimeLabel FROM dashboard_configs WHERE is_default = 1 LIMIT 1",
    "SELECT id, name, timezone, eod_run_time_label as eodRunTimeLabel FROM dashboard_configs ORDER BY id ASC LIMIT 1",
  ] as const;

  for (const sql of fallbackCandidates) {
    try {
      const row = await env.DB.prepare(sql).first<any>();
      if (!row) continue;
      return {
        id: String(row.id),
        name: String(row.name ?? "Default Swing Dashboard"),
        timezone: String(row.timezone ?? DEFAULT_REFRESH_TIMEZONE),
        eodRunLocalTime: String(row.eodRunLocalTime ?? DEFAULT_REFRESH_TIME),
        eodRunTimeLabel: buildRefreshLabel(String(row.eodRunLocalTime ?? DEFAULT_REFRESH_TIME), String(row.timezone ?? DEFAULT_REFRESH_TIMEZONE)),
      };
    } catch {
      // Try next fallback shape.
    }
  }

  // Last-resort bootstrap so admin can recover even with empty/mismatched DB.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO dashboard_configs (id, name, is_default, timezone, eod_run_local_time, eod_run_time_label) VALUES (?, ?, 1, ?, ?, ?)",
  )
    .bind("default", "Default Swing Dashboard", DEFAULT_REFRESH_TIMEZONE, DEFAULT_REFRESH_TIME, buildRefreshLabel(DEFAULT_REFRESH_TIME, DEFAULT_REFRESH_TIMEZONE))
    .run();
  return {
    id: "default",
    name: "Default Swing Dashboard",
    timezone: DEFAULT_REFRESH_TIMEZONE,
    eodRunLocalTime: DEFAULT_REFRESH_TIME,
    eodRunTimeLabel: buildRefreshLabel(DEFAULT_REFRESH_TIME, DEFAULT_REFRESH_TIMEZONE),
  };
}

export async function loadConfig(env: Env, configId = "default"): Promise<DashboardConfigPayload> {
  const config = await resolveConfigRow(env, configId);

  const sections = await env.DB.prepare(
    "SELECT id, title, description, is_collapsible as isCollapsible, default_collapsed as defaultCollapsed, sort_order FROM dashboard_sections WHERE config_id = ? ORDER BY sort_order ASC",
  )
    .bind(config.id)
    .all<{
      id: string;
      title: string;
      description: string | null;
      isCollapsible: number;
      defaultCollapsed: number;
      sort_order: number;
    }>();

  const sectionRows = (sections.results ?? []).filter((section) => section.id !== "sec-tools");
  const groups = await env.DB.prepare(
    "SELECT id, section_id as sectionId, title, sort_order, data_type as dataType, ranking_window_default as rankingWindowDefault, show_sparkline as showSparkline, pin_top10 as pinTop10 FROM dashboard_groups WHERE section_id IN (SELECT id FROM dashboard_sections WHERE config_id = ?) ORDER BY sort_order ASC",
  )
    .bind(config.id)
    .all<{
      id: string;
      sectionId: string;
      title: string;
      sort_order: number;
      dataType: string;
      rankingWindowDefault: "1D" | "5D" | "1W" | "YTD" | "52W";
      showSparkline: number;
      pinTop10: number;
    }>();

  const groupRows = groups.results ?? [];
  let items;
  try {
    items = await env.DB.prepare(
      "SELECT id, group_id as groupId, sort_order, ticker, display_name as displayName, enabled, tags_json as tagsJson, holdings_json as holdingsJson FROM dashboard_items ORDER BY sort_order ASC",
    ).all<{
      id: string;
      groupId: string;
      sort_order: number;
      ticker: string;
      displayName: string | null;
      enabled: number;
      tagsJson: string | null;
      holdingsJson: string | null;
    }>();
  } catch {
    items = await env.DB.prepare(
      "SELECT id, group_id as groupId, sort_order, ticker, display_name as displayName, enabled, tags_json as tagsJson FROM dashboard_items ORDER BY sort_order ASC",
    ).all<{
      id: string;
      groupId: string;
      sort_order: number;
      ticker: string;
      displayName: string | null;
      enabled: number;
      tagsJson: string | null;
      holdingsJson?: string | null;
    }>();
  }
  const itemRows = items.results ?? [];
  const tickers = Array.from(new Set(itemRows.map((item) => item.ticker).filter(Boolean)));
  const symbolNameMap = new Map<string, string>();
  const etfUniverseMetaByTicker = new Map<string, {
    isManaged: true;
    listType: "sector" | "industry";
    fundName: string | null;
  }>();
  for (let index = 0; index < tickers.length; index += SYMBOL_LOOKUP_CHUNK_SIZE) {
    const batch = tickers.slice(index, index + SYMBOL_LOOKUP_CHUNK_SIZE);
    if (batch.length === 0) continue;
    const rows = await env.DB.prepare(
      `SELECT ticker, name FROM symbols WHERE ticker IN (${batch.map(() => "?").join(",")})`,
    )
      .bind(...batch)
      .all<{ ticker: string; name: string | null }>();
    for (const row of rows.results ?? []) {
      symbolNameMap.set(row.ticker, row.name ?? "");
    }
    const etfRows = await env.DB.prepare(
      `SELECT ticker, list_type as listType, fund_name as fundName
       FROM etf_watchlists
       WHERE ticker IN (${batch.map(() => "?").join(",")})
       ORDER BY CASE WHEN list_type = 'industry' THEN 0 ELSE 1 END, ticker ASC`,
    )
      .bind(...batch)
      .all<{ ticker: string; listType: "sector" | "industry"; fundName: string | null }>();
    for (const row of etfRows.results ?? []) {
      const ticker = row.ticker.toUpperCase();
      if (!etfUniverseMetaByTicker.has(ticker)) {
        etfUniverseMetaByTicker.set(ticker, {
          isManaged: true,
          listType: row.listType === "industry" ? "industry" : "sector",
          fundName: row.fundName?.trim() || null,
        });
      }
    }
  }

  const columns = await env.DB.prepare("SELECT group_id as groupId, columns_json as columnsJson FROM dashboard_columns").all<{
    groupId: string;
    columnsJson: string;
  }>();
  const colMap = new Map((columns.results ?? []).map((c) => [c.groupId, parseJsonSafe<string[]>(c.columnsJson, defaultColumns)]));

  return {
    ...config,
    sections: sectionRows.map((sec) => ({
      id: sec.id,
      title: sec.title,
      description: sec.description,
      isCollapsible: !!sec.isCollapsible,
      defaultCollapsed: !!sec.defaultCollapsed,
      order: sec.sort_order,
      groups: groupRows
        .filter((g) => g.sectionId === sec.id)
        .map((g) => {
          const itemsForGroup = itemRows
            .filter((it) => it.groupId === g.id)
            .map((it) => {
              const ticker = it.ticker.toUpperCase();
              const etfUniverseMeta = etfUniverseMetaByTicker.get(ticker) ?? null;
              const managedDisplayName = etfUniverseMeta?.fundName ?? symbolNameMap.get(it.ticker) ?? it.ticker;
              return {
                id: it.id,
                ticker: it.ticker,
                displayName: etfUniverseMeta ? managedDisplayName : (it.displayName ?? symbolNameMap.get(it.ticker) ?? it.ticker),
                isEtfUniverseManaged: Boolean(etfUniverseMeta?.isManaged),
                etfUniverseListType: etfUniverseMeta?.listType ?? null,
                etfUniverseFundName: etfUniverseMeta?.fundName ?? null,
                order: it.sort_order,
                enabled: !!it.enabled,
                tags: parseJsonSafe<string[]>(it.tagsJson, []),
                holdings: parseJsonSafe<string[] | null>(it.holdingsJson, null),
              };
            });
          const baseColumns = colMap.get(g.id) ?? defaultColumns;
          const overviewColumns = (() => {
            if (g.dataType === "macro" || g.dataType === "equities") {
              const withName = (() => {
                if (baseColumns.includes("name")) return baseColumns;
                const at = baseColumns.indexOf("ticker");
                if (at >= 0) {
                  const next = [...baseColumns];
                  next.splice(at + 1, 0, "name");
                  return next;
                }
                return ["ticker", "name", ...baseColumns];
              })();
              return normalizeOverviewColumns(withName);
            }
            return baseColumns;
          })();
          return {
            id: g.id,
            title: g.title,
            order: g.sort_order,
            dataType: g.dataType,
            rankingWindowDefault: g.rankingWindowDefault,
            showSparkline: !!g.showSparkline,
            pinTop10: !!g.pinTop10,
            columns: reorderOverviewColumnsForGroup(
              g.id,
              withOverviewSmaPilotColumns(g.id, withOverviewPilotColumns(g.id, itemsForGroup, overviewColumns)),
            ),
            items: itemsForGroup,
          };
        }),
    })),
  };
}

export async function upsertAudit(env: Env, configId: string, action: string, payload: unknown, actor = "admin"): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO config_audit (id, config_id, action, actor, payload_json) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(uid(), configId, action, actor, JSON.stringify(payload))
    .run();
}
