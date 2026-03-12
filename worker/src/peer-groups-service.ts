import type { Env } from "./types";

export type PeerGroupType = "fundamental" | "technical" | "custom";
export type PeerMembershipSource = "manual" | "fmp_seed" | "finnhub_seed" | "system";

export type PeerGroupRecord = {
  id: string;
  slug: string;
  name: string;
  groupType: PeerGroupType;
  description: string | null;
  priority: number;
  isActive: boolean;
  memberCount?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type PeerDirectoryRow = {
  ticker: string;
  name: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  groups: PeerGroupRecord[];
};

export type PeerTickerMember = {
  ticker: string;
  name: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  source: PeerMembershipSource;
  confidence: number | null;
};

export type PeerTickerDetail = {
  symbol: {
    ticker: string;
    name: string | null;
    exchange: string | null;
    sector: string | null;
    industry: string | null;
    sharesOutstanding: number | null;
  };
  groups: Array<PeerGroupRecord & { members: PeerTickerMember[] }>;
};

function normalizeTicker(value: string): string {
  return String(value ?? "").trim().toUpperCase();
}

const US_EXCHANGES = new Set([
  "NASDAQ",
  "NASDAQ NMS - GLOBAL MARKET",
  "NASDAQ CAPITAL MARKET",
  "NASDAQ GLOBAL SELECT",
  "NEW YORK STOCK EXCHANGE, INC.",
  "NYSE",
  "NYSE ARCA",
  "NYSEARCA",
  "NYSE AMERICAN",
  "NYSE MKT LLC",
  "AMEX",
  "ARCA",
  "BATS",
  "IEX",
]);

export function isValidBootstrapRootTicker(value: string): boolean {
  const ticker = normalizeTicker(value);
  if (!ticker) return false;
  if (!/^[A-Z]{1,5}([.-][A-Z])?$/.test(ticker)) return false;
  if (ticker === "CASH" || ticker === "USD") return false;
  const dotIndex = ticker.indexOf(".");
  if (dotIndex >= 0) {
    const suffix = ticker.slice(dotIndex + 1);
    if (suffix.length > 1) return false;
  }
  return true;
}

export function isUsEquityExchange(exchange: string | null | undefined): boolean {
  if (!exchange) return true;
  return US_EXCHANGES.has(String(exchange).trim().toUpperCase());
}

type TableExistsRow = { count: number };
type ColumnExistsRow = { count: number };

export function normalizePeerGroupType(value: string | null | undefined): PeerGroupType {
  if (value === "technical" || value === "custom") return value;
  return "fundamental";
}

export function slugifyPeerGroupName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "peer-group";
}

export function mergeMembershipSource(existing: PeerMembershipSource | null | undefined, incoming: PeerMembershipSource): PeerMembershipSource {
  if (existing === "manual" || incoming === "manual") return "manual";
  if (existing === "system" || incoming === "system") return "system";
  if (!existing) return incoming;
  if (existing !== incoming) return "system";
  return incoming;
}

async function tableExists(env: Env, tableName: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).bind(tableName).first<TableExistsRow>();
  return Number(row?.count ?? 0) > 0;
}

async function columnExists(env: Env, tableName: string, columnName: string): Promise<boolean> {
  const safeTable = tableName === "symbols" ? "symbols" : tableName;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM pragma_table_info('${safeTable}') WHERE name = ?`,
  ).bind(columnName).first<ColumnExistsRow>();
  return Number(row?.count ?? 0) > 0;
}

export async function hasPeerGroupSchema(env: Env): Promise<boolean> {
  const [groupsTable, membershipsTable] = await Promise.all([
    tableExists(env, "peer_groups"),
    tableExists(env, "ticker_peer_groups"),
  ]);
  return groupsTable && membershipsTable;
}

export async function hasSharesOutstandingColumn(env: Env): Promise<boolean> {
  return columnExists(env, "symbols", "shares_outstanding");
}

export async function listPeerBootstrapCandidates(
  env: Env,
  input: {
    limit?: number | null;
    offset?: number | null;
    q?: string | null;
    onlyUnseeded?: boolean | null;
  } = {},
): Promise<Array<{ ticker: string; name: string | null; exchange: string | null }>> {
  if (!(await hasPeerGroupSchema(env))) throw new Error("Peer Groups schema is missing. Apply migration 0011_peer_groups.sql first.");
  const limit = Math.max(1, Math.min(100, Number(input.limit ?? 10)));
  const offset = Math.max(0, Number(input.offset ?? 0));
  const q = String(input.q ?? "").trim();
  const qUpper = q.toUpperCase();
  const params: Array<string | number> = [];
  const where = ["(s.asset_class IS NULL OR s.asset_class IN ('equity', 'stock'))"];
  if (input.onlyUnseeded !== false) {
    where.push("NOT EXISTS (SELECT 1 FROM ticker_peer_groups tpg WHERE tpg.ticker = s.ticker)");
  }
  if (q) {
    where.push("(s.ticker = ? OR s.ticker LIKE ? OR s.name LIKE ? COLLATE NOCASE)");
    params.push(qUpper, `${qUpper}%`, `%${q}%`);
  }
  const orderParams = q
    ? [qUpper, qUpper, qUpper, `${qUpper}%`, q, `%${q}%`]
    : ["", "", "", "", "", ""];
  const accepted: Array<{ ticker: string; name: string | null; exchange: string | null }> = [];
  const seen = new Set<string>();
  let rawOffset = offset;
  const scanLimit = Math.max(50, Math.min(500, limit * 5));

  while (accepted.length < limit) {
    const rows = await env.DB.prepare(
      `SELECT s.ticker, s.name, s.exchange
       FROM symbols s
       WHERE ${where.join(" AND ")}
       ORDER BY
         CASE
           WHEN ? <> '' AND s.ticker = ? THEN 0
           WHEN ? <> '' AND s.ticker LIKE ? THEN 1
           WHEN ? <> '' AND s.name LIKE ? COLLATE NOCASE THEN 2
           ELSE 3
         END,
         s.ticker ASC
       LIMIT ? OFFSET ?`,
    )
      .bind(...params, ...orderParams, scanLimit, rawOffset)
      .all<{ ticker: string; name: string | null; exchange: string | null }>();

    const rawRows = rows.results ?? [];
    if (rawRows.length === 0) break;

    for (const row of rawRows) {
      const ticker = normalizeTicker(row.ticker);
      if (!isValidBootstrapRootTicker(ticker) || !isUsEquityExchange(row.exchange) || seen.has(ticker)) continue;
      accepted.push({
        ticker,
        name: row.name ?? null,
        exchange: row.exchange ?? null,
      });
      seen.add(ticker);
      if (accepted.length >= limit) break;
    }

    rawOffset += rawRows.length;
  }

  return accepted;
}

export async function listPeerGroups(env: Env, includeInactive = true): Promise<PeerGroupRecord[]> {
  if (!(await hasPeerGroupSchema(env))) return [];
  const rows = await env.DB.prepare(
    `SELECT
      pg.id,
      pg.slug,
      pg.name,
      pg.group_type as groupType,
      pg.description,
      pg.priority,
      pg.is_active as isActive,
      pg.created_at as createdAt,
      pg.updated_at as updatedAt,
      COUNT(tpg.ticker) as memberCount
    FROM peer_groups pg
    LEFT JOIN ticker_peer_groups tpg ON tpg.peer_group_id = pg.id
    ${includeInactive ? "" : "WHERE pg.is_active = 1"}
    GROUP BY pg.id
    ORDER BY pg.is_active DESC, pg.priority DESC, pg.name ASC`,
  ).all<{
    id: string;
    slug: string;
    name: string;
    groupType: PeerGroupType;
    description: string | null;
    priority: number;
    isActive: number;
    createdAt: string;
    updatedAt: string;
    memberCount: number;
  }>();

  return (rows.results ?? []).map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    groupType: normalizePeerGroupType(row.groupType),
    description: row.description ?? null,
    priority: Number(row.priority ?? 0),
    isActive: Boolean(row.isActive),
    memberCount: Number(row.memberCount ?? 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function queryPeerDirectory(
  env: Env,
  input: {
    q?: string | null;
    groupId?: string | null;
    groupType?: string | null;
    active?: string | null;
    limit?: number | null;
    offset?: number | null;
  },
): Promise<{ rows: PeerDirectoryRow[]; total: number; limit: number; offset: number }> {
  const q = String(input.q ?? "").trim();
  const qUpper = q.toUpperCase();
  const groupId = String(input.groupId ?? "").trim();
  const groupType = input.groupType ? normalizePeerGroupType(input.groupType) : null;
  const active = input.active === "0" ? 0 : input.active === "1" ? 1 : null;
  const limit = Math.max(1, Math.min(100, Number(input.limit ?? 50)));
  const offset = Math.max(0, Number(input.offset ?? 0));
  const schemaReady = await hasPeerGroupSchema(env);

  const where: string[] = ["(s.asset_class IS NULL OR s.asset_class IN ('equity', 'stock'))"];
  const params: Array<string | number> = [];

  if (schemaReady && !q && !groupId && !groupType && active == null) {
    where.push("EXISTS (SELECT 1 FROM ticker_peer_groups tpg WHERE tpg.ticker = s.ticker)");
  }

  if (q) {
    where.push("(s.ticker = ? OR s.ticker LIKE ? OR s.name LIKE ? COLLATE NOCASE)");
    params.push(qUpper, `${qUpper}%`, `%${q}%`);
  }
  if (schemaReady && groupId) {
    where.push("EXISTS (SELECT 1 FROM ticker_peer_groups tpg WHERE tpg.ticker = s.ticker AND tpg.peer_group_id = ?)");
    params.push(groupId);
  }
  if (schemaReady && groupType) {
    where.push("EXISTS (SELECT 1 FROM ticker_peer_groups tpg JOIN peer_groups pg ON pg.id = tpg.peer_group_id WHERE tpg.ticker = s.ticker AND pg.group_type = ?)");
    params.push(groupType);
  }
  if (schemaReady && active != null) {
    where.push("EXISTS (SELECT 1 FROM ticker_peer_groups tpg JOIN peer_groups pg ON pg.id = tpg.peer_group_id WHERE tpg.ticker = s.ticker AND pg.is_active = ?)");
    params.push(active);
  }

  const whereSql = where.join(" AND ");
  const countRow = await env.DB.prepare(`SELECT COUNT(*) as count FROM symbols s WHERE ${whereSql}`)
    .bind(...params)
    .first<{ count: number }>();

  const orderParams = q
    ? [qUpper, qUpper, qUpper, `${qUpper}%`, q, `%${q}%`]
    : ["", "", "", "", "", ""];
  const symbolRows = await env.DB.prepare(
    `SELECT s.ticker, s.name, s.exchange, s.sector, s.industry
     FROM symbols s
     WHERE ${whereSql}
     ORDER BY
       CASE
         WHEN ? <> '' AND s.ticker = ? THEN 0
         WHEN ? <> '' AND s.ticker LIKE ? THEN 1
         WHEN ? <> '' AND s.name LIKE ? COLLATE NOCASE THEN 2
         ELSE 3
       END,
       s.ticker ASC
     LIMIT ? OFFSET ?`,
  )
    .bind(...params, ...orderParams, limit, offset)
    .all<{
      ticker: string;
      name: string | null;
      exchange: string | null;
      sector: string | null;
      industry: string | null;
    }>();

  const tickers = (symbolRows.results ?? []).map((row) => row.ticker.toUpperCase());
  const groupsByTicker = new Map<string, PeerGroupRecord[]>();
  if (schemaReady && tickers.length > 0) {
    const memberships = await env.DB.prepare(
      `SELECT
        tpg.ticker,
        pg.id,
        pg.slug,
        pg.name,
        pg.group_type as groupType,
        pg.description,
        pg.priority,
        pg.is_active as isActive
      FROM ticker_peer_groups tpg
      JOIN peer_groups pg ON pg.id = tpg.peer_group_id
      WHERE tpg.ticker IN (${tickers.map(() => "?").join(",")})
      ORDER BY pg.priority DESC, pg.name ASC`,
    )
      .bind(...tickers)
      .all<{
        ticker: string;
        id: string;
        slug: string;
        name: string;
        groupType: PeerGroupType;
        description: string | null;
        priority: number;
        isActive: number;
      }>();
    for (const row of memberships.results ?? []) {
      const current = groupsByTicker.get(row.ticker.toUpperCase()) ?? [];
      current.push({
        id: row.id,
        slug: row.slug,
        name: row.name,
        groupType: normalizePeerGroupType(row.groupType),
        description: row.description ?? null,
        priority: Number(row.priority ?? 0),
        isActive: Boolean(row.isActive),
      });
      groupsByTicker.set(row.ticker.toUpperCase(), current);
    }
  }

  return {
    rows: (symbolRows.results ?? []).map((row) => ({
      ticker: row.ticker.toUpperCase(),
      name: row.name ?? null,
      exchange: row.exchange ?? null,
      sector: row.sector ?? null,
      industry: row.industry ?? null,
      groups: groupsByTicker.get(row.ticker.toUpperCase()) ?? [],
    })),
    total: Number(countRow?.count ?? 0),
    limit,
    offset,
  };
}

export async function loadPeerTickerDetail(env: Env, tickerInput: string): Promise<PeerTickerDetail | null> {
  const ticker = normalizeTicker(tickerInput);
  if (!ticker) return null;
  const sharesOutstandingColumn = await hasSharesOutstandingColumn(env);
  const symbol = await env.DB.prepare(
    `SELECT ticker, name, exchange, sector, industry${sharesOutstandingColumn ? ", shares_outstanding as sharesOutstanding" : ", NULL as sharesOutstanding"} FROM symbols WHERE ticker = ? LIMIT 1`,
  )
    .bind(ticker)
    .first<{
      ticker: string;
      name: string | null;
      exchange: string | null;
      sector: string | null;
      industry: string | null;
      sharesOutstanding: number | null;
  }>();
  if (!symbol) return null;
  const schemaReady = await hasPeerGroupSchema(env);
  if (!schemaReady) {
    return {
      symbol: {
        ticker: symbol.ticker.toUpperCase(),
        name: symbol.name ?? null,
        exchange: symbol.exchange ?? null,
        sector: symbol.sector ?? null,
        industry: symbol.industry ?? null,
        sharesOutstanding: typeof symbol.sharesOutstanding === "number" ? symbol.sharesOutstanding : null,
      },
      groups: [],
    };
  }

  const groupRows = await env.DB.prepare(
    `SELECT
      pg.id,
      pg.slug,
      pg.name,
      pg.group_type as groupType,
      pg.description,
      pg.priority,
      pg.is_active as isActive,
      pg.created_at as createdAt,
      pg.updated_at as updatedAt
    FROM ticker_peer_groups tpg
    JOIN peer_groups pg ON pg.id = tpg.peer_group_id
    WHERE tpg.ticker = ?
    ORDER BY pg.is_active DESC, pg.priority DESC, pg.name ASC`,
  )
    .bind(ticker)
    .all<{
      id: string;
      slug: string;
      name: string;
      groupType: PeerGroupType;
      description: string | null;
      priority: number;
      isActive: number;
      createdAt: string;
      updatedAt: string;
    }>();
  const groups = (groupRows.results ?? []).map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    groupType: normalizePeerGroupType(row.groupType),
    description: row.description ?? null,
    priority: Number(row.priority ?? 0),
    isActive: Boolean(row.isActive),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    members: [] as PeerTickerMember[],
  }));
  if (groups.length === 0) {
    return {
      symbol: {
        ticker: symbol.ticker,
        name: symbol.name ?? null,
        exchange: symbol.exchange ?? null,
        sector: symbol.sector ?? null,
        industry: symbol.industry ?? null,
        sharesOutstanding: typeof symbol.sharesOutstanding === "number" ? symbol.sharesOutstanding : null,
      },
      groups,
    };
  }

  const groupIds = groups.map((group) => group.id);
  const members = await env.DB.prepare(
    `SELECT
      tpg.peer_group_id as groupId,
      tpg.ticker,
      tpg.source,
      tpg.confidence,
      s.name,
      s.exchange,
      s.sector,
      s.industry
    FROM ticker_peer_groups tpg
    LEFT JOIN symbols s ON s.ticker = tpg.ticker
    WHERE tpg.peer_group_id IN (${groupIds.map(() => "?").join(",")})
    ORDER BY CASE WHEN tpg.ticker = ? THEN 0 ELSE 1 END, tpg.ticker ASC`,
  )
    .bind(...groupIds, ticker)
    .all<{
      groupId: string;
      ticker: string;
      source: PeerMembershipSource;
      confidence: number | null;
      name: string | null;
      exchange: string | null;
      sector: string | null;
      industry: string | null;
    }>();
  const membersByGroup = new Map<string, PeerTickerMember[]>();
  for (const row of members.results ?? []) {
    const current = membersByGroup.get(row.groupId) ?? [];
    current.push({
      ticker: row.ticker.toUpperCase(),
      name: row.name ?? null,
      exchange: row.exchange ?? null,
      sector: row.sector ?? null,
      industry: row.industry ?? null,
      source: row.source,
      confidence: typeof row.confidence === "number" ? row.confidence : null,
    });
    membersByGroup.set(row.groupId, current);
  }

  return {
    symbol: {
      ticker: symbol.ticker.toUpperCase(),
      name: symbol.name ?? null,
      exchange: symbol.exchange ?? null,
      sector: symbol.sector ?? null,
      industry: symbol.industry ?? null,
      sharesOutstanding: typeof symbol.sharesOutstanding === "number" ? symbol.sharesOutstanding : null,
    },
    groups: groups.map((group) => ({
      ...group,
      members: membersByGroup.get(group.id) ?? [],
    })),
  };
}

export async function createPeerGroup(
  env: Env,
  payload: {
    name: string;
    slug?: string | null;
    groupType?: string | null;
    description?: string | null;
    priority?: number | null;
    isActive?: boolean | null;
  },
): Promise<{ id: string }> {
  if (!(await hasPeerGroupSchema(env))) throw new Error("Peer Groups schema is missing. Apply migration 0011_peer_groups.sql first.");
  const name = payload.name.trim();
  const slug = slugifyPeerGroupName(payload.slug?.trim() || name);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO peer_groups (id, slug, name, group_type, description, priority, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      slug,
      name,
      normalizePeerGroupType(payload.groupType),
      payload.description?.trim() || null,
      Number(payload.priority ?? 0),
      payload.isActive === false ? 0 : 1,
    )
    .run();
  return { id };
}

export async function updatePeerGroup(
  env: Env,
  groupId: string,
  payload: {
    name?: string | null;
    slug?: string | null;
    groupType?: string | null;
    description?: string | null;
    priority?: number | null;
    isActive?: boolean | null;
  },
): Promise<void> {
  if (!(await hasPeerGroupSchema(env))) throw new Error("Peer Groups schema is missing. Apply migration 0011_peer_groups.sql first.");
  const existing = await env.DB.prepare("SELECT id, name, slug, group_type as groupType, description, priority, is_active as isActive FROM peer_groups WHERE id = ?")
    .bind(groupId)
    .first<{
      id: string;
      name: string;
      slug: string;
      groupType: PeerGroupType;
      description: string | null;
      priority: number;
      isActive: number;
    }>();
  if (!existing) throw new Error("Peer group not found.");
  await env.DB.prepare(
    "UPDATE peer_groups SET slug = ?, name = ?, group_type = ?, description = ?, priority = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(
      slugifyPeerGroupName(payload.slug?.trim() || payload.name?.trim() || existing.slug),
      payload.name?.trim() || existing.name,
      normalizePeerGroupType(payload.groupType || existing.groupType),
      payload.description?.trim() ?? existing.description ?? null,
      payload.priority != null ? Number(payload.priority) : Number(existing.priority ?? 0),
      payload.isActive == null ? existing.isActive : payload.isActive ? 1 : 0,
      groupId,
    )
    .run();
}

export async function deletePeerGroup(env: Env, groupId: string): Promise<void> {
  if (!(await hasPeerGroupSchema(env))) throw new Error("Peer Groups schema is missing. Apply migration 0011_peer_groups.sql first.");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ticker_peer_groups WHERE peer_group_id = ?").bind(groupId),
    env.DB.prepare("DELETE FROM peer_groups WHERE id = ?").bind(groupId),
  ]);
}

export async function upsertTickerPeerMembership(
  env: Env,
  input: {
    ticker: string;
    peerGroupId: string;
    source: PeerMembershipSource;
    confidence?: number | null;
  },
): Promise<void> {
  if (!(await hasPeerGroupSchema(env))) throw new Error("Peer Groups schema is missing. Apply migration 0011_peer_groups.sql first.");
  const ticker = normalizeTicker(input.ticker);
  const existing = await env.DB.prepare(
    "SELECT source, confidence FROM ticker_peer_groups WHERE ticker = ? AND peer_group_id = ?",
  )
    .bind(ticker, input.peerGroupId)
    .first<{ source: PeerMembershipSource | null; confidence: number | null }>();

  await env.DB.prepare(
    `INSERT INTO ticker_peer_groups (ticker, peer_group_id, source, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(ticker, peer_group_id) DO UPDATE SET
       source = ?,
       confidence = ?,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      ticker,
      input.peerGroupId,
      mergeMembershipSource(existing?.source, input.source),
      input.confidence ?? existing?.confidence ?? null,
      mergeMembershipSource(existing?.source, input.source),
      input.confidence ?? existing?.confidence ?? null,
    )
    .run();
}

export async function removeTickerPeerMembership(env: Env, peerGroupId: string, tickerInput: string): Promise<void> {
  if (!(await hasPeerGroupSchema(env))) throw new Error("Peer Groups schema is missing. Apply migration 0011_peer_groups.sql first.");
  await env.DB.prepare("DELETE FROM ticker_peer_groups WHERE peer_group_id = ? AND ticker = ?")
    .bind(peerGroupId, normalizeTicker(tickerInput))
    .run();
}
