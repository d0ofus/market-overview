import type { Env } from "./types";

const VERSION_MEMBER_BATCH_SIZE = 100;

type UniverseRule = {
  minMembers: number;
  maxMembers: number;
  maxChangePct: number;
};

const UNIVERSE_RULES: Record<string, UniverseRule> = {
  "sp500-core": { minMembers: 480, maxMembers: 525, maxChangePct: 5 },
  "nasdaq-core": { minMembers: 2_500, maxMembers: 5_000, maxChangePct: 15 },
  "nyse-core": { minMembers: 1_500, maxMembers: 3_500, maxChangePct: 15 },
  "overall-market-proxy": { minMembers: 4_000, maxMembers: 8_000, maxChangePct: 15 },
  "russell2000-core": { minMembers: 1_800, maxMembers: 2_100, maxChangePct: 15 },
};

export type UniverseCandidateValidation = {
  valid: boolean;
  memberCount: number;
  previousMemberCount: number;
  changePct: number | null;
  error: string | null;
};

export type UniverseVersionRecord = {
  id: string;
  universeId: string;
  source: string;
  sourceAsOfDate: string | null;
  status: string;
  memberCount: number;
  previousMemberCount: number | null;
  changePct: number | null;
  validationError: string | null;
  createdAt: string;
  promotedAt: string | null;
};

function normalizeTickers(tickers: string[]): string[] {
  return Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right));
}

export function validateUniverseCandidate(input: {
  universeId: string;
  tickers: string[];
  previousTickers?: string[];
  approveLargeChange?: boolean;
}): UniverseCandidateValidation {
  const candidate = normalizeTickers(input.tickers);
  const previous = normalizeTickers(input.previousTickers ?? []);
  const rule = UNIVERSE_RULES[input.universeId];
  const previousSet = new Set(previous);
  const candidateSet = new Set(candidate);
  const changedMembers = previous.length === 0
    ? 0
    : candidate.filter((ticker) => !previousSet.has(ticker)).length
      + previous.filter((ticker) => !candidateSet.has(ticker)).length;
  const changePct = previous.length > 0 ? (changedMembers / previous.length) * 100 : null;

  if (!rule) {
    return {
      valid: candidate.length > 0,
      memberCount: candidate.length,
      previousMemberCount: previous.length,
      changePct,
      error: candidate.length > 0 ? null : "candidate universe is empty",
    };
  }
  if (candidate.length < rule.minMembers || candidate.length > rule.maxMembers) {
    return {
      valid: false,
      memberCount: candidate.length,
      previousMemberCount: previous.length,
      changePct,
      error: `member count ${candidate.length} is outside ${rule.minMembers}-${rule.maxMembers}`,
    };
  }
  if (!input.approveLargeChange && changePct != null && changePct > rule.maxChangePct) {
    return {
      valid: false,
      memberCount: candidate.length,
      previousMemberCount: previous.length,
      changePct,
      error: `membership change ${changePct.toFixed(2)}% exceeds ${rule.maxChangePct}%`,
    };
  }
  return {
    valid: true,
    memberCount: candidate.length,
    previousMemberCount: previous.length,
    changePct,
    error: null,
  };
}

export async function loadActiveUniverseTickers(env: Env, universeId: string): Promise<string[]> {
  try {
    const versionRows = await env.DB.prepare(
      `SELECT uvm.ticker
         FROM universes u
         JOIN universe_version_members uvm ON uvm.version_id = u.active_version_id
        WHERE u.id = ?
        ORDER BY uvm.ticker`,
    ).bind(universeId).all<{ ticker: string }>();
    const versionTickers = normalizeTickers((versionRows.results ?? []).map((row) => row.ticker));
    if (versionTickers.length > 0) return versionTickers;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (!/no such (?:table|column)/i.test(message)) throw error;
  }
  const legacyRows = await env.DB.prepare(
    "SELECT ticker FROM universe_symbols WHERE universe_id = ? ORDER BY ticker",
  ).bind(universeId).all<{ ticker: string }>();
  return normalizeTickers((legacyRows.results ?? []).map((row) => row.ticker));
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let offset = 0; offset < statements.length; offset += VERSION_MEMBER_BATCH_SIZE) {
    await db.batch(statements.slice(offset, offset + VERSION_MEMBER_BATCH_SIZE));
  }
}

async function promoteUniverseVersion(
  env: Env,
  universeId: string,
  versionId: string,
  tickers: string[],
): Promise<void> {
  await runBatches(env.DB, tickers.map((ticker) => env.DB.prepare(
    "INSERT OR IGNORE INTO symbols (ticker, name, asset_class) VALUES (?, ?, 'equity')",
  ).bind(ticker, ticker)));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM universe_symbols WHERE universe_id = ?").bind(universeId),
    env.DB.prepare(
      `INSERT INTO universe_symbols (universe_id, ticker)
       SELECT ?, ticker FROM universe_version_members WHERE version_id = ?`,
    ).bind(universeId, versionId),
    env.DB.prepare(
      "UPDATE universes SET active_version_id = ? WHERE id = ?",
    ).bind(versionId, universeId),
    env.DB.prepare(
      `UPDATE universe_versions
          SET status = 'active', promoted_at = CURRENT_TIMESTAMP, validation_error = NULL
        WHERE id = ?`,
    ).bind(versionId),
    env.DB.prepare(
      `UPDATE universe_versions
          SET status = 'superseded'
        WHERE universe_id = ? AND status = 'active' AND id <> ?`,
    ).bind(universeId, versionId),
  ]);
}

export async function stageAndPromoteUniverseVersion(env: Env, input: {
  universeId: string;
  universeName: string;
  source: string;
  sourceAsOfDate?: string | null;
  tickers: string[];
  approveLargeChange?: boolean;
  versionId?: string;
}): Promise<{ versionId: string; validation: UniverseCandidateValidation }> {
  const tickers = normalizeTickers(input.tickers);
  const previousTickers = await loadActiveUniverseTickers(env, input.universeId);
  const validation = validateUniverseCandidate({
    universeId: input.universeId,
    tickers,
    previousTickers,
    approveLargeChange: input.approveLargeChange,
  });
  const versionId = input.versionId ?? crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO universes (id, name) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
  ).bind(input.universeId, input.universeName).run();
  await env.DB.prepare(
    `INSERT INTO universe_versions
       (id, universe_id, source, source_as_of_date, status, member_count,
        previous_member_count, change_pct, validation_error)
     VALUES (?, ?, ?, ?, 'staging', ?, ?, ?, ?)`,
  ).bind(
    versionId,
    input.universeId,
    input.source,
    input.sourceAsOfDate ?? null,
    validation.memberCount,
    validation.previousMemberCount,
    validation.changePct,
    validation.error,
  ).run();
  await runBatches(env.DB, tickers.map((ticker) => env.DB.prepare(
    "INSERT OR IGNORE INTO universe_version_members (version_id, ticker) VALUES (?, ?)",
  ).bind(versionId, ticker)));

  if (!validation.valid) {
    await env.DB.prepare(
      "UPDATE universe_versions SET status = 'rejected' WHERE id = ?",
    ).bind(versionId).run();
    throw new Error(`Rejected ${input.universeId} universe candidate: ${validation.error}`);
  }

  await promoteUniverseVersion(env, input.universeId, versionId, tickers);
  return { versionId, validation };
}

export async function listUniverseVersions(
  env: Env,
  universeId?: string | null,
  limit = 100,
): Promise<UniverseVersionRecord[]> {
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const query = `SELECT id, universe_id as universeId, source,
      source_as_of_date as sourceAsOfDate, status, member_count as memberCount,
      previous_member_count as previousMemberCount, change_pct as changePct,
      validation_error as validationError, created_at as createdAt, promoted_at as promotedAt
    FROM universe_versions`;
  const result = universeId
    ? await env.DB.prepare(`${query} WHERE universe_id = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(universeId, boundedLimit).all<UniverseVersionRecord>()
    : await env.DB.prepare(`${query} ORDER BY created_at DESC LIMIT ?`)
      .bind(boundedLimit).all<UniverseVersionRecord>();
  return result.results ?? [];
}

export async function approveUniverseVersion(
  env: Env,
  versionId: string,
): Promise<{ versionId: string; universeId: string; validation: UniverseCandidateValidation }> {
  const version = await env.DB.prepare(
    `SELECT id, universe_id as universeId, status
       FROM universe_versions
      WHERE id = ? LIMIT 1`,
  ).bind(versionId).first<{ id: string; universeId: string; status: string }>();
  if (!version) throw new Error("Universe version not found.");
  const rows = await env.DB.prepare(
    "SELECT ticker FROM universe_version_members WHERE version_id = ? ORDER BY ticker",
  ).bind(versionId).all<{ ticker: string }>();
  const tickers = normalizeTickers((rows.results ?? []).map((row) => row.ticker));
  const previousTickers = await loadActiveUniverseTickers(env, version.universeId);
  const validation = validateUniverseCandidate({
    universeId: version.universeId,
    tickers,
    previousTickers,
    approveLargeChange: true,
  });
  if (!validation.valid) {
    throw new Error(`Universe candidate still fails validation: ${validation.error}`);
  }
  await promoteUniverseVersion(env, version.universeId, versionId, tickers);
  return { versionId, universeId: version.universeId, validation };
}
