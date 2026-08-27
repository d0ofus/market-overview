import type { Env } from "./types";
import { getMarketDataDb } from "./market-data-db";

const VERSION_MEMBER_BATCH_SIZE = 100;
const UNIVERSE_VERSION_RETENTION = 5;

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

function normalizeDiagnosticSymbols(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim().toUpperCase()).filter(Boolean))).sort();
}

export async function computeUniverseMembershipHash(tickers: string[]): Promise<string> {
  const normalized = normalizeTickers(tickers).join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validateUniverseCandidate(input: {
  universeId: string;
  tickers: string[];
  sourceMemberCount?: number | null;
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
  const sourceMemberCount = input.sourceMemberCount ?? candidate.length;
  const resolutionCoveragePct = sourceMemberCount > 0 ? (candidate.length / sourceMemberCount) * 100 : 0;

  if (!rule) {
    return {
      valid: candidate.length > 0,
      memberCount: candidate.length,
      previousMemberCount: previous.length,
      changePct,
      error: candidate.length > 0 ? null : "candidate universe is empty",
    };
  }
  if (sourceMemberCount < rule.minMembers || sourceMemberCount > rule.maxMembers) {
    return {
      valid: false,
      memberCount: candidate.length,
      previousMemberCount: previous.length,
      changePct,
      error: `member count ${sourceMemberCount} is outside ${rule.minMembers}-${rule.maxMembers}`,
    };
  }
  if (candidate.length < rule.minMembers || candidate.length > rule.maxMembers) {
    return {
      valid: false,
      memberCount: candidate.length,
      previousMemberCount: previous.length,
      changePct,
      error: `resolved member count ${candidate.length} is outside ${rule.minMembers}-${rule.maxMembers}`,
    };
  }
  if (input.universeId === "russell2000-core" && resolutionCoveragePct < 95) {
    return {
      valid: false,
      memberCount: candidate.length,
      previousMemberCount: previous.length,
      changePct,
      error: `symbol resolution coverage ${resolutionCoveragePct.toFixed(2)}% is below 95%`,
    };
  }
  const previousWasValid = previous.length >= rule.minMembers && previous.length <= rule.maxMembers;
  if (!input.approveLargeChange && previousWasValid && changePct != null && changePct > rule.maxChangePct) {
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
  const db = getMarketDataDb(env);
  try {
    const versionRows = await db.prepare(
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
  const legacyRows = await db.prepare(
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
  const db = getMarketDataDb(env);
  await db.batch([
    db.prepare("DELETE FROM universe_symbols WHERE universe_id = ?").bind(universeId),
    db.prepare(
      `INSERT INTO universe_symbols (universe_id, ticker)
       SELECT ?, ticker FROM universe_version_members WHERE version_id = ?`,
    ).bind(universeId, versionId),
    db.prepare(
      "UPDATE universes SET active_version_id = ? WHERE id = ?",
    ).bind(versionId, universeId),
    db.prepare(
      `UPDATE universe_versions
          SET status = 'active', promoted_at = CURRENT_TIMESTAMP, validation_error = NULL
        WHERE id = ?`,
    ).bind(versionId),
    db.prepare(
      `UPDATE universe_versions
          SET status = 'superseded'
        WHERE universe_id = ? AND status = 'active' AND id <> ?`,
    ).bind(universeId, versionId),
  ]);
}

async function pruneUniverseVersions(env: Env, universeId: string, retainedVersionId: string): Promise<void> {
  const db = getMarketDataDb(env);
  const universe = await db.prepare(
    "SELECT active_version_id as activeVersionId FROM universes WHERE id = ?",
  ).bind(universeId).first<{ activeVersionId?: string | null }>();
  const protectedIds = new Set(
    [retainedVersionId, universe?.activeVersionId].filter((id): id is string => Boolean(id)),
  );
  const rows = await db.prepare(
    `SELECT uv.id FROM universe_versions uv
      WHERE uv.universe_id = ?
      ORDER BY uv.created_at DESC, uv.id DESC`,
  ).bind(universeId).all<{ id: string }>();
  const unprotectedRows = (rows.results ?? []).filter((row) => !protectedIds.has(row.id));
  const unprotectedRetention = Math.max(0, UNIVERSE_VERSION_RETENTION - protectedIds.size);
  const staleIds = unprotectedRows.slice(unprotectedRetention).map((row) => row.id);
  if (staleIds.length === 0) return;
  await runBatches(db, staleIds.map((id) => db.prepare(
    "DELETE FROM universe_version_members WHERE version_id = ?",
  ).bind(id)));
  await runBatches(db, staleIds.map((id) => db.prepare(
    "DELETE FROM universe_versions WHERE id = ?",
  ).bind(id)));
}

export async function stageAndPromoteUniverseVersion(env: Env, input: {
  universeId: string;
  universeName: string;
  source: string;
  sourceType?: string | null;
  sourceUrl?: string | null;
  sourceAsOfDate?: string | null;
  sourceMemberCount?: number | null;
  normalizedMemberCount?: number | null;
  unresolvedCount?: number | null;
  unresolvedTickers?: string[];
  tickers: string[];
  memberMetadata?: Record<string, {
    sourceTicker: string;
    issuerName: string | null;
    exchange: string | null;
    assetClass: string;
  }>;
  approveLargeChange?: boolean;
  versionId?: string;
}): Promise<{ versionId: string; validation: UniverseCandidateValidation; unchanged?: boolean }> {
  const db = getMarketDataDb(env);
  const tickers = normalizeTickers(input.tickers);
  const previousTickers = await loadActiveUniverseTickers(env, input.universeId);
  const validation = validateUniverseCandidate({
    universeId: input.universeId,
    tickers,
    sourceMemberCount: input.sourceMemberCount,
    previousTickers,
    approveLargeChange: input.approveLargeChange,
  });
  const membershipHash = await computeUniverseMembershipHash(tickers);
  const activeVersion = await db.prepare(
    `SELECT uv.id, uv.membership_hash as membershipHash
       FROM universes u
       JOIN universe_versions uv ON uv.id = u.active_version_id
      WHERE u.id = ? LIMIT 1`,
  ).bind(input.universeId).first<{ id: string; membershipHash: string | null }>();
  const sameMembership = Boolean(activeVersion)
    && (activeVersion?.membershipHash === membershipHash
      || (previousTickers.length === tickers.length && previousTickers.every((ticker, index) => ticker === tickers[index])));
  if (validation.valid && sameMembership) {
    await db.prepare(
      `UPDATE universe_versions
          SET source = ?, source_type = ?, source_url = ?, source_as_of_date = ?,
              source_member_count = ?, normalized_member_count = ?, resolved_member_count = ?, unresolved_count = ?,
              unresolved_symbols_json = ?, membership_hash = ?
        WHERE id = ?`,
    ).bind(
      input.source,
      input.sourceType ?? null,
      input.sourceUrl ?? null,
      input.sourceAsOfDate ?? null,
      input.sourceMemberCount ?? tickers.length,
      input.normalizedMemberCount ?? tickers.length,
      tickers.length,
      input.unresolvedCount ?? Math.max(0, (input.sourceMemberCount ?? tickers.length) - tickers.length),
      JSON.stringify(normalizeDiagnosticSymbols(input.unresolvedTickers ?? [])),
      membershipHash,
      activeVersion!.id,
    ).run();
    return { versionId: activeVersion!.id, validation, unchanged: true };
  }
  const versionId = input.versionId ?? crypto.randomUUID();

  await db.prepare(
    `INSERT INTO universes (id, name) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
  ).bind(input.universeId, input.universeName).run();
  await db.prepare(
    `INSERT INTO universe_versions
       (id, universe_id, source, source_type, source_url, source_as_of_date, status, member_count,
        source_member_count, normalized_member_count, resolved_member_count, unresolved_count, unresolved_symbols_json, membership_hash,
        previous_member_count, change_pct, validation_error)
     VALUES (?, ?, ?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    versionId,
    input.universeId,
    input.source,
    input.sourceType ?? null,
    input.sourceUrl ?? null,
    input.sourceAsOfDate ?? null,
    validation.memberCount,
    input.sourceMemberCount ?? tickers.length,
    input.normalizedMemberCount ?? tickers.length,
    tickers.length,
    input.unresolvedCount ?? Math.max(0, (input.sourceMemberCount ?? tickers.length) - tickers.length),
    JSON.stringify(normalizeDiagnosticSymbols(input.unresolvedTickers ?? [])),
    membershipHash,
    validation.previousMemberCount,
    validation.changePct,
    validation.error,
  ).run();
  await runBatches(db, tickers.map((ticker) => {
    const metadata = input.memberMetadata?.[ticker];
    return db.prepare(
      `INSERT OR IGNORE INTO universe_version_members
        (version_id, ticker, source_ticker, issuer_name, exchange, asset_class)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      versionId,
      ticker,
      metadata?.sourceTicker ?? ticker,
      metadata?.issuerName ?? null,
      metadata?.exchange ?? null,
      metadata?.assetClass ?? null,
    );
  }));

  if (!validation.valid) {
    await db.prepare(
      "UPDATE universe_versions SET status = 'rejected' WHERE id = ?",
    ).bind(versionId).run();
    await pruneUniverseVersions(env, input.universeId, versionId);
    throw new Error(`Rejected ${input.universeId} universe candidate: ${validation.error}`);
  }

  await promoteUniverseVersion(env, input.universeId, versionId, tickers);
  await pruneUniverseVersions(env, input.universeId, versionId);
  return { versionId, validation };
}

export async function listUniverseVersions(
  env: Env,
  universeId?: string | null,
  limit = 100,
): Promise<UniverseVersionRecord[]> {
  const db = getMarketDataDb(env);
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const query = `SELECT id, universe_id as universeId, source,
      source_as_of_date as sourceAsOfDate, status, member_count as memberCount,
      previous_member_count as previousMemberCount, change_pct as changePct,
      validation_error as validationError, created_at as createdAt, promoted_at as promotedAt
    FROM universe_versions`;
  const result = universeId
    ? await db.prepare(`${query} WHERE universe_id = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(universeId, boundedLimit).all<UniverseVersionRecord>()
    : await db.prepare(`${query} ORDER BY created_at DESC LIMIT ?`)
      .bind(boundedLimit).all<UniverseVersionRecord>();
  return result.results ?? [];
}

export async function approveUniverseVersion(
  env: Env,
  versionId: string,
): Promise<{ versionId: string; universeId: string; validation: UniverseCandidateValidation }> {
  const db = getMarketDataDb(env);
  const version = await db.prepare(
    `SELECT id, universe_id as universeId, status, source_member_count as sourceMemberCount,
            source_as_of_date as sourceAsOfDate
       FROM universe_versions
      WHERE id = ? LIMIT 1`,
  ).bind(versionId).first<{
    id: string;
    universeId: string;
    status: string;
    sourceMemberCount: number | null;
    sourceAsOfDate: string | null;
  }>();
  if (!version) throw new Error("Universe version not found.");
  if (version.status !== "rejected") {
    throw new Error(`Universe version is not reviewable (status: ${version.status}).`);
  }
  if (version.universeId === "russell2000-core") {
    const sourceMs = version.sourceAsOfDate ? Date.parse(`${version.sourceAsOfDate}T00:00:00Z`) : Number.NaN;
    const sourceAgeDays = Number.isFinite(sourceMs)
      ? Math.floor((Date.now() - sourceMs) / 86_400_000)
      : Number.POSITIVE_INFINITY;
    if (sourceAgeDays < -1 || sourceAgeDays > 14) {
      throw new Error("Universe candidate source date is missing or stale; refresh the source before approval.");
    }
  }
  const rows = await db.prepare(
    "SELECT ticker FROM universe_version_members WHERE version_id = ? ORDER BY ticker",
  ).bind(versionId).all<{ ticker: string }>();
  const tickers = normalizeTickers((rows.results ?? []).map((row) => row.ticker));
  const previousTickers = await loadActiveUniverseTickers(env, version.universeId);
  const validation = validateUniverseCandidate({
    universeId: version.universeId,
    tickers,
    sourceMemberCount: version.sourceMemberCount,
    previousTickers,
    approveLargeChange: true,
  });
  if (!validation.valid) {
    throw new Error(`Universe candidate still fails validation: ${validation.error}`);
  }
  await promoteUniverseVersion(env, version.universeId, versionId, tickers);
  await pruneUniverseVersions(env, version.universeId, versionId);
  return { versionId, universeId: version.universeId, validation };
}
