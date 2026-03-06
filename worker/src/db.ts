import type { DashboardConfigPayload, Env } from "./types";

const uid = () => crypto.randomUUID();
const defaultColumns = ["ticker", "name", "price", "1D", "1W", "3M", "6M", "YTD", "sparkline"];

function normalizeOverviewColumns(columns: string[]): string[] {
  const includeTicker = columns.includes("ticker");
  const includeName = columns.includes("name");
  const includePrice = columns.includes("price");
  const includeSparkline = columns.includes("sparkline");
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
  ];
  return Array.from(new Set(normalized));
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
        eodRunLocalTime: "08:15",
        eodRunTimeLabel: legacyById.eodRunTimeLabel || "08:15 Australia/Melbourne",
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
        timezone: String(row.timezone ?? "Australia/Melbourne"),
        eodRunLocalTime: String(row.eodRunLocalTime ?? "08:15"),
        eodRunTimeLabel: String(row.eodRunTimeLabel ?? "08:15 Australia/Melbourne"),
      };
    } catch {
      // Try next fallback shape.
    }
  }

  // Last-resort bootstrap so admin can recover even with empty/mismatched DB.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO dashboard_configs (id, name, is_default, timezone, eod_run_local_time, eod_run_time_label) VALUES (?, ?, 1, ?, ?, ?)",
  )
    .bind("default", "Default Swing Dashboard", "Australia/Melbourne", "08:15", "08:15 Australia/Melbourne")
    .run();
  return {
    id: "default",
    name: "Default Swing Dashboard",
    timezone: "Australia/Melbourne",
    eodRunLocalTime: "08:15",
    eodRunTimeLabel: "08:15 Australia/Melbourne",
  };
}

export async function loadConfig(env: Env, configId = "default"): Promise<DashboardConfigPayload> {
  const config = await resolveConfigRow(env, configId);

  const sections = await env.DB.prepare(
    "SELECT id, title, description, is_collapsible as isCollapsible, default_collapsed as defaultCollapsed, sort_order FROM dashboard_sections WHERE config_id = ? ORDER BY sort_order ASC",
  )
    .bind(configId)
    .all<{
      id: string;
      title: string;
      description: string | null;
      isCollapsible: number;
      defaultCollapsed: number;
      sort_order: number;
    }>();

  const sectionRows = sections.results ?? [];
  const groups = await env.DB.prepare(
    "SELECT id, section_id as sectionId, title, sort_order, data_type as dataType, ranking_window_default as rankingWindowDefault, show_sparkline as showSparkline, pin_top10 as pinTop10 FROM dashboard_groups WHERE section_id IN (SELECT id FROM dashboard_sections WHERE config_id = ?) ORDER BY sort_order ASC",
  )
    .bind(configId)
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
        .map((g) => ({
          id: g.id,
          title: g.title,
          order: g.sort_order,
          dataType: g.dataType,
          rankingWindowDefault: g.rankingWindowDefault,
          showSparkline: !!g.showSparkline,
          pinTop10: !!g.pinTop10,
          columns: (() => {
            const base = colMap.get(g.id) ?? defaultColumns;
            if (g.dataType === "macro" || g.dataType === "equities") {
              const withName = (() => {
                if (base.includes("name")) return base;
                const at = base.indexOf("ticker");
                if (at >= 0) {
                  const next = [...base];
                  next.splice(at + 1, 0, "name");
                  return next;
                }
                return ["ticker", "name", ...base];
              })();
              return normalizeOverviewColumns(withName);
            }
            return base;
          })(),
          items: itemRows
            .filter((it) => it.groupId === g.id)
            .map((it) => ({
              id: it.id,
              ticker: it.ticker,
              displayName: it.displayName,
              order: it.sort_order,
              enabled: !!it.enabled,
              tags: parseJsonSafe<string[]>(it.tagsJson, []),
              holdings: parseJsonSafe<string[] | null>(it.holdingsJson, null),
            })),
        })),
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
