import type { DashboardConfigPayload, Env } from "./types";

const uid = () => crypto.randomUUID();

export async function loadConfig(env: Env, configId = "default"): Promise<DashboardConfigPayload> {
  const config = await env.DB.prepare(
    "SELECT id, name, timezone, eod_run_time_label as eodRunTimeLabel FROM dashboard_configs WHERE id = ?",
  )
    .bind(configId)
    .first<{ id: string; name: string; timezone: string; eodRunTimeLabel: string }>();
  if (!config) {
    throw new Error(`Missing dashboard config ${configId}`);
  }

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
  const items = await env.DB.prepare(
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
  const itemRows = items.results ?? [];

  const columns = await env.DB.prepare("SELECT group_id as groupId, columns_json as columnsJson FROM dashboard_columns").all<{
    groupId: string;
    columnsJson: string;
  }>();
  const colMap = new Map((columns.results ?? []).map((c) => [c.groupId, JSON.parse(c.columnsJson) as string[]]));

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
          columns: colMap.get(g.id) ?? ["ticker", "price", "1D", "1W", "YTD", "sparkline"],
          items: itemRows
            .filter((it) => it.groupId === g.id)
            .map((it) => ({
              id: it.id,
              ticker: it.ticker,
              displayName: it.displayName,
              order: it.sort_order,
              enabled: !!it.enabled,
              tags: it.tagsJson ? (JSON.parse(it.tagsJson) as string[]) : [],
              holdings: it.holdingsJson ? (JSON.parse(it.holdingsJson) as string[]) : null,
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
