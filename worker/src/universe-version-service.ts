import type { Env } from "./types";
import { getMarketDataDb } from "./market-data-db";

const VERSION_MEMBER_CHUNK_SIZE = 400;
// Table + primary-key index + reverse ticker index: at most 24,000 member
// writes in the single atomic compatibility/pointer transaction.
const MAX_ATOMIC_MEMBERSHIP_CHANGES = 8_000;
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
  return hashText(normalizeTickers(tickers).join("\n"));
}

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
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

async function promoteUniverseVersion(
  env: Env,
  universeId: string,
  versionId: string,
  tickers: string[],
  expectedVersionId: string | null,
): Promise<void> {
  const db = getMarketDataDb(env);
  const universe = await db.prepare(
    "SELECT active_version_id as activeVersionId FROM universes WHERE id = ?",
  ).bind(universeId).first<{ activeVersionId: string | null }>();
  if (!universe) throw new Error("universe-promotion-conflict: universe disappeared before promotion");
  if (universe.activeVersionId !== expectedVersionId) {
    throw new Error("universe-promotion-conflict: active membership changed since validation");
  }
  const legacy = await db.prepare(
    "SELECT ticker FROM universe_symbols WHERE universe_id = ? ORDER BY ticker",
  ).bind(universeId).all<{ ticker: string }>();
  const oldTickers = new Set((legacy.results ?? []).map((row) => row.ticker));
  const newTickers = new Set(tickers);
  const removed = [...oldTickers].filter((ticker) => !newTickers.has(ticker));
  const added = tickers.filter((ticker) => !oldTickers.has(ticker));
  if (removed.length + added.length > MAX_ATOMIC_MEMBERSHIP_CHANGES) {
    throw new Error("universe-promotion-capacity: compatibility delta exceeds 8000 members; staged version retained");
  }
  // Each statement uses the same old pointer. A competing promotion makes the
  // entire batch a no-op; the read after the transaction detects that conflict.
  // Never expose a partially replaced legacy universe between chunks.
  await db.batch([
    db.prepare(
      `DELETE FROM universe_symbols WHERE universe_id = ?
         AND ticker IN (SELECT value FROM json_each(?))
         AND EXISTS (SELECT 1 FROM universes WHERE id = ? AND active_version_id IS ?)
       /* eod-universe-promote-delete */`,
    ).bind(universeId, JSON.stringify(removed), universeId, expectedVersionId),
    db.prepare(
      `INSERT OR IGNORE INTO universe_symbols (universe_id, ticker)
       SELECT ?, value FROM json_each(?)
        WHERE EXISTS (SELECT 1 FROM universes WHERE id = ? AND active_version_id IS ?)
       /* eod-universe-promote-insert */`,
    ).bind(universeId, JSON.stringify(added), universeId, expectedVersionId),
    db.prepare(
      `UPDATE universes SET active_version_id = ? WHERE id = ? AND active_version_id IS ?
       /* eod-universe-promote-pointer */`,
    ).bind(versionId, universeId, expectedVersionId),
    db.prepare(
      `UPDATE universe_versions
          SET status = 'active', promoted_at = CURRENT_TIMESTAMP, validation_error = NULL
        WHERE id = ? AND EXISTS (SELECT 1 FROM universes WHERE id = ? AND active_version_id = ?)
       /* eod-universe-promote-active */`,
    ).bind(versionId, universeId, versionId),
    db.prepare(
      `UPDATE universe_versions
          SET status = 'superseded'
        WHERE id = ? AND id <> ? AND status = 'active'
          AND EXISTS (SELECT 1 FROM universes WHERE id = ? AND active_version_id = ?)
       /* eod-universe-promote-supersede */`,
    ).bind(expectedVersionId, versionId, universeId, versionId),
  ]);
  const promoted = await db.prepare(
    "SELECT active_version_id as activeVersionId FROM universes WHERE id = ?",
  ).bind(universeId).first<{ activeVersionId: string | null }>();
  if (promoted?.activeVersionId !== versionId) {
    throw new Error("universe-promotion-conflict: active membership changed while promoting; retry validation");
  }
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
      WHERE uv.universe_id = ? AND uv.status = 'rejected'
      ORDER BY uv.created_at DESC, uv.id DESC`,
  ).bind(universeId).all<{ id: string }>();
  const unprotectedRows = (rows.results ?? []).filter((row) => !protectedIds.has(row.id));
  const unprotectedRetention = Math.max(0, UNIVERSE_VERSION_RETENTION - protectedIds.size);
  const staleIds = unprotectedRows.slice(unprotectedRetention).map((row) => row.id);
  if (staleIds.length === 0) return;
  for (const id of staleIds) {
    const members = await db.prepare(
      "SELECT ticker FROM universe_version_members WHERE version_id = ? ORDER BY ticker",
    ).bind(id).all<{ ticker: string }>();
    for (let offset = 0; offset < (members.results ?? []).length; offset += VERSION_MEMBER_CHUNK_SIZE) {
      const chunk = members.results.slice(offset, offset + VERSION_MEMBER_CHUNK_SIZE).map((row) => row.ticker);
      await db.prepare(
        `DELETE FROM universe_version_members WHERE version_id = ?
           AND ticker IN (SELECT value FROM json_each(?))
           AND EXISTS (SELECT 1 FROM universe_versions WHERE id = ? AND status = 'rejected')
           AND NOT EXISTS (SELECT 1 FROM universes WHERE active_version_id = ?)
         /* eod-universe-prune-members */`,
      ).bind(id, JSON.stringify(chunk), id, id).run();
    }
    await db.prepare("DELETE FROM universe_versions WHERE id = ? AND status = 'rejected'").bind(id).run();
  }
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
  const membershipHash = await computeUniverseMembershipHash(tickers);
  const activeVersion = await db.prepare(
    `SELECT uv.id, uv.membership_hash as membershipHash, uv.source,
            uv.source_type as sourceType, uv.source_url as sourceUrl
       FROM universes u
       JOIN universe_versions uv ON uv.id = u.active_version_id
      WHERE u.id = ? LIMIT 1`,
  ).bind(input.universeId).first<{
    id: string; membershipHash: string | null; source: string; sourceType: string | null; sourceUrl: string | null;
  }>();
  const previousTickers = await loadActiveUniverseTickers(env, input.universeId);
  const validation = validateUniverseCandidate({
    universeId: input.universeId,
    tickers,
    sourceMemberCount: input.sourceMemberCount,
    previousTickers,
    approveLargeChange: input.approveLargeChange,
  });
  const sameMembership = Boolean(activeVersion)
    && (activeVersion?.membershipHash === membershipHash
      || (previousTickers.length === tickers.length && previousTickers.every((ticker, index) => ticker === tickers[index])));
  const sameSource = activeVersion?.source === input.source
    && activeVersion.sourceType === (input.sourceType ?? null)
    && activeVersion.sourceUrl === (input.sourceUrl ?? null);
  if (validation.valid && sameMembership && sameSource) {
    // Accepted membership/provenance is an immutable historical input. Fresh
    // verification belongs to universe_source_sync_state, not this version.
    return { versionId: activeVersion!.id, validation, unchanged: true };
  }
  // Dates belong to verification metadata. Excluding them from the identity
  // allows the next UTC day's quota to resume a partially staged candidate.
  // Provider identity remains included so a verified primary can replace a
  // bundled/fallback source without rewriting accepted historical provenance.
  const versionId = input.versionId ?? `uv-${await hashText(JSON.stringify([
    input.universeId, membershipHash, input.source, input.sourceType ?? null, input.sourceUrl ?? null,
    activeVersion?.id ?? null,
  ]))}`;
  const existingVersion = await db.prepare(
    `SELECT universe_id as universeId, membership_hash as membershipHash, source, status,
            source_type as sourceType, source_url as sourceUrl
       FROM universe_versions WHERE id = ?`,
  ).bind(versionId).first<{
    universeId: string; membershipHash: string; source: string; status: string; sourceType: string | null; sourceUrl: string | null;
  }>();
  if (existingVersion && (existingVersion.universeId !== input.universeId
    || existingVersion.membershipHash !== membershipHash || existingVersion.source !== input.source
    || existingVersion.sourceType !== (input.sourceType ?? null) || existingVersion.sourceUrl !== (input.sourceUrl ?? null))) {
    throw new Error("universe-stage-integrity: version ID already belongs to different membership or provenance");
  }
  if (existingVersion && !["staging", "rejected"].includes(existingVersion.status)) {
    throw new Error("universe-stage-integrity: accepted historical membership cannot be restaged");
  }

  if (!existingVersion) await db.prepare(
    `INSERT INTO universes (id, name) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
  ).bind(input.universeId, input.universeName).run();
  if (!existingVersion) await db.prepare(
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
  if (tickers.length > MAX_ATOMIC_MEMBERSHIP_CHANGES) {
    await db.prepare("UPDATE universe_versions SET status = 'rejected' WHERE id = ?").bind(versionId).run();
    throw new Error(`Rejected ${input.universeId} universe candidate: member count exceeds bounded 8000-member capacity`);
  }
  const staged = await db.prepare(
    "SELECT ticker FROM universe_version_members WHERE version_id = ? ORDER BY ticker",
  ).bind(versionId).all<{ ticker: string }>();
  const stagedTickers = new Set((staged.results ?? []).map((row) => row.ticker));
  const requested = new Set(tickers);
  if ([...stagedTickers].some((ticker) => !requested.has(ticker))) {
    throw new Error("universe-stage-integrity: staged membership contains unexpected symbols");
  }
  const missing = tickers.filter((ticker) => !stagedTickers.has(ticker));
  for (let offset = 0; offset < missing.length; offset += VERSION_MEMBER_CHUNK_SIZE) {
    const chunk = missing.slice(offset, offset + VERSION_MEMBER_CHUNK_SIZE).map((ticker) => {
      const metadata = input.memberMetadata?.[ticker];
      return [ticker, metadata?.sourceTicker ?? ticker, metadata?.issuerName ?? null,
        metadata?.exchange ?? null, metadata?.assetClass ?? null];
    });
    await db.prepare(
      `INSERT OR IGNORE INTO universe_version_members
         (version_id, ticker, source_ticker, issuer_name, exchange, asset_class)
       SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'),
              json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]')
         FROM json_each(?) /* eod-universe-stage */`,
    ).bind(versionId, JSON.stringify(chunk)).run();
  }
  const complete = await db.prepare(
    "SELECT ticker FROM universe_version_members WHERE version_id = ? ORDER BY ticker",
  ).bind(versionId).all<{ ticker: string }>();
  if ((complete.results ?? []).length !== tickers.length
    || await computeUniverseMembershipHash((complete.results ?? []).map((row) => row.ticker)) !== membershipHash) {
    throw new Error("universe-stage-integrity: incomplete membership cannot be promoted");
  }

  if (!validation.valid) {
    await db.prepare(
      "UPDATE universe_versions SET status = 'rejected' WHERE id = ?",
    ).bind(versionId).run();
    await pruneUniverseVersions(env, input.universeId, versionId);
    throw new Error(`Rejected ${input.universeId} universe candidate: ${validation.error}`);
  }

  await promoteUniverseVersion(env, input.universeId, versionId, tickers, activeVersion?.id ?? null);
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
  const activeVersion = await db.prepare(
    "SELECT active_version_id as activeVersionId FROM universes WHERE id = ?",
  ).bind(version.universeId).first<{ activeVersionId: string | null }>();
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
  await promoteUniverseVersion(env, version.universeId, versionId, tickers, activeVersion?.activeVersionId ?? null);
  await pruneUniverseVersions(env, version.universeId, versionId);
  return { versionId, universeId: version.universeId, validation };
}
