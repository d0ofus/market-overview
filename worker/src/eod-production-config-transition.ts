import { parse } from "smol-toml";
import { eodHash } from "./eod-publication-service";
import { validateEodCutoverEvidence, type EodCutoverEvidence } from "./eod-rollout-service";
import type { StorageMigrationIdentity } from "./market-storage-control";

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const sha = (value: string) => /^[a-f0-9]{40}$/.test(value);
function fail(reason: string): never { throw new Error(`storage-config-transition-${reason}`); }
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  const row = object(value);
  return row ? Object.fromEntries(Object.keys(row).sort().map((key) => [key, ordered(row[key])])) : value;
}

/** Git must prove every tracked file outside this TOML is byte-identical to the
 * migration's approved execution revision. Only this source-to-target config transition
 * may reuse its runtime measurements; arbitrary later code cannot use it. */
export async function validateProductionConfigDelta(input: {
  identity: StorageMigrationIdentity; nextRevision: string; changedFiles: string[];
  approvedToml: string; candidateToml: string; targetDatabaseName: string;
}): Promise<{ approvedConfigHash: string; candidateConfigHash: string }> {
  if (!sha(input.identity.codeRevision) || !sha(input.nextRevision) || input.nextRevision === input.identity.codeRevision
    || input.changedFiles.length !== 1 || input.changedFiles[0] !== "worker/wrangler.toml") fail("configuration-only-commit-required");
  let approved: Record<string, unknown>, candidate: Record<string, unknown>;
  try { approved = parse(input.approvedToml) as Record<string, unknown>; candidate = parse(input.candidateToml) as Record<string, unknown>; }
  catch { fail("toml-invalid"); }
  const vars = object(approved.vars), nextVars = object(candidate.vars);
  if (!vars || !nextVars || vars.EOD_RUNNER_MODE !== "shadow" || vars.EOD_READ_ENABLED !== "false"
    || vars.EOD_ARCHIVE_PRUNE_ENABLED !== "false" || Object.hasOwn(vars, "EOD_CODE_REVISION")
    || Object.hasOwn(nextVars, "EOD_CODE_REVISION") || !Array.isArray(approved.d1_databases)) fail("approved-source-config-invalid");
  const expected = structuredClone(approved), expectedVars = object(expected.vars)!;
  expectedVars.EOD_RUNNER_MODE = "active"; expectedVars.EOD_READ_ENABLED = "true";
  expectedVars.EOD_ARCHIVE_PRUNE_ENABLED = "true";
  if (nextVars.EOD_STORAGE_MIGRATION_ID !== undefined) {
    if (nextVars.EOD_STORAGE_MIGRATION_ID !== input.identity.id) fail("migration-identity-changed");
    expectedVars.EOD_STORAGE_MIGRATION_ID = input.identity.id;
  }
  const bindings = (expected.d1_databases as unknown[]).map(object);
  const market = bindings.filter((row) => row?.binding === "MARKET_DATA_DB");
  if (bindings.some((row) => !row) || new Set(bindings.map((row) => row!.binding)).size !== bindings.length
    || market.length !== 1 || market[0]!.database_id !== input.identity.sourceDatabaseId
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.targetDatabaseName)) fail("source-binding-invalid");
  market[0]!.database_id = input.identity.targetDatabaseId; market[0]!.database_name = input.targetDatabaseName;
  if (JSON.stringify(ordered(candidate)) !== JSON.stringify(ordered(expected))) fail("unapproved-runtime-config-change");
  return { approvedConfigHash: await eodHash(input.approvedToml), candidateConfigHash: await eodHash(input.candidateToml) };
}

/** Keep collection dates and measurement values intact. Existing live approval
 * validation checks the accepted run, payloads, catalog and revision clock. */
export function deriveProductionConfigProof(input: {
  sourceProof: unknown; identity: StorageMigrationIdentity; nextRevision: string; expectedSession: string;
  targetBytes: number; historyBytes: number; now?: Date;
}): EodCutoverEvidence {
  const source = validateEodCutoverEvidence(input.sourceProof, input.identity.codeRevision, input.now);
  if (!sha(input.nextRevision) || input.nextRevision === input.identity.codeRevision) fail("revision-invalid");
  if (source.sessionDate !== input.expectedSession) fail("current-session-proof-required");
  // Storage acceptance encodes projectedMarketBytes in marketDatabaseBytes,
  // and projectedHistoryBytes as archiveDatabaseBytes+additionalArchiveBytes.
  // These include measured growth reserves, not the old live file sizes.
  if (![input.targetBytes, input.historyBytes].every((value) => Number.isSafeInteger(value) && value > 0 && value < 350_000_000)
    || input.targetBytes > source.capacity.marketDatabaseBytes
    || input.historyBytes > source.capacity.archiveDatabaseBytes + source.capacity.additionalArchiveBytes) fail("current-capacity-exceeds-evidence");
  return validateEodCutoverEvidence({ ...source, codeRevision: input.nextRevision }, input.nextRevision, input.now);
}
