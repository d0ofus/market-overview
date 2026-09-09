import { eodHash } from "./eod-publication-service";
import { EOD_RUNTIME_COORDINATOR_PATH, EOD_RUNTIME_HTTP_PATHS } from "./eod-runtime-telemetry";
import type { StorageMigrationIdentity, StorageMigrationRun } from "./market-storage-control";
import type { RuntimeEvidenceIdentity } from "./eod-runtime-evidence";
import type { StoragePublicationEvidence } from "./market-storage-acceptance";
import { eodSlot } from "./eod-coordinator";
import { zonedParts } from "./refresh-timing";

export function assertRuntimeCandidateWindow(now: Date, session: { sessionDate: string; closeAt: string } | null): void {
  const local = zonedParts(now, "America/New_York");
  if (!session || session.sessionDate !== local.localDate
    || (!eodSlot(now, session) && !(local.minutesOfDay >= 9 * 60 && local.minutesOfDay < 10 * 60))) {
    throw new Error("runtime-candidate-await-actual-coordinator-window");
  }
}

/** Collection and completed/ambiguous samples allocate no expiring resources.
 * New configuration, deployment and further probes require a real window. */
export function runtimeCandidateRequiresWindow(command: "prepare" | "run" | "collect", state?: {
  secretsInstalled?: boolean; samples?: CandidateProbeState;
}): boolean {
  if (command === "collect") return false;
  if (!state) return true;
  if (command === "prepare") return false;
  return !state.secretsInstalled || !state.samples
    || (state.samples.probes.length < 5 && state.samples.probes.every((probe) => probe.status === "ok"));
}

export function runtimeCandidatePublicationHash(publications: StoragePublicationEvidence): Promise<string> {
  return eodHash({ runId: publications.runId, sessionDate: publications.sessionDate, inputClock: publications.inputClock,
    tickerHash: publications.tickerHash, scopes: publications.scopes, membershipHash: publications.membershipHash, catalogHash: publications.catalogHash });
}

export type CandidateIdentity = Omit<RuntimeEvidenceIdentity, "workerVersion"> & {
  migrationId: string; sourceDatabaseId: string; sessionDate: string; attempt: number;
};
export type CandidateConfig = Record<string, unknown> & { name: string; vars: Record<string, string>; d1_databases: Array<Record<string, unknown>> };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runtime-candidate-object-invalid");
  return value as Record<string, unknown>;
}
export async function runtimeCandidateIdentity(input: {
  migration: StorageMigrationIdentity; sessionDate: string; opsDatabaseId: string; coreDatabaseId: string; attempt?: number;
}): Promise<CandidateIdentity> {
  const attempt = input.attempt ?? 1, migration = input.migration;
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 4 || !/^\d{4}-\d{2}-\d{2}$/.test(input.sessionDate)
    || !/^[a-f0-9]{40}$/.test(migration.codeRevision) || !migration.id.startsWith("market-storage:")) throw new Error("runtime-candidate-identity-invalid");
  const ids = [migration.sourceDatabaseId, migration.targetDatabaseId, migration.historyDatabaseId, input.opsDatabaseId, input.coreDatabaseId];
  if (!ids.every((id) => uuid.test(id)) || new Set(ids).size !== ids.length) throw new Error("runtime-candidate-database-identity-conflict");
  const suffix = (await eodHash([migration.id, input.sessionDate, migration.codeRevision, attempt])).slice(0, 24);
  return { migrationId: migration.id, sourceDatabaseId: migration.sourceDatabaseId, targetDatabaseId: migration.targetDatabaseId,
    historyDatabaseId: migration.historyDatabaseId, opsDatabaseId: input.opsDatabaseId, coreDatabaseId: input.coreDatabaseId,
    sessionDate: input.sessionDate, codeRevision: migration.codeRevision, attempt, workerName: `market-eod-probe-${suffix}`, probeId: `eod-${suffix}` };
}

export function assertCandidateMigrationState(run: StorageMigrationRun, identity: StorageMigrationIdentity, now = new Date()): void {
  if (run.status !== "awaiting-evidence" || run.stage !== "storage-final-acceptance-required" || run.freeze_authorized !== 1
    || !run.source_schema_hash || run.source_revision === null || (run.lease_until && run.lease_until > now.toISOString())
    || run.id !== identity.id || run.code_revision !== identity.codeRevision || run.source_database_id !== identity.sourceDatabaseId
    || run.target_database_id !== identity.targetDatabaseId || run.history_database_id !== identity.historyDatabaseId
    || run.session_date !== identity.sessionDate) throw new Error("runtime-candidate-private-bootstrap-not-ready");
}

/** Copy reviewed runtime settings while making event ingress and bindings
 * explicit. Unknown top-level capabilities require review, never inheritance. */
export function prepareRuntimeCandidateConfig(reviewed: unknown, identity: CandidateIdentity, options: {
  mainPath: string; probeUntil: string; now?: Date;
}): CandidateConfig {
  const config = record(reviewed), now = (options.now ?? new Date()).getTime(), until = Date.parse(options.probeUntil);
  if (typeof config.name !== "string" || config.name === identity.workerName || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(identity.workerName)
    || !Number.isFinite(until) || until <= now || until - now > 86_400_000 || !options.mainPath.endsWith("index.ts")) throw new Error("runtime-candidate-config-invalid");
  const retained = new Set(["name", "main", "compatibility_date", "compatibility_flags", "account_id", "vars", "d1_databases",
    "limits", "placement", "rules", "alias", "define", "minify", "no_bundle", "tsconfig", "find_additional_modules"]);
  const removed = new Set(["queues", "triggers", "routes", "route", "send_email", "email", "workers_dev", "preview_urls", "observability", "version_metadata", "logpush", "$schema"]);
  for (const key of Object.keys(config)) if (!retained.has(key) && !removed.has(key)) throw new Error(`runtime-candidate-unreviewed-config:${key}`);
  const result = Object.fromEntries(Object.entries(config).filter(([key]) => retained.has(key))) as CandidateConfig;
  result.name = identity.workerName; result.main = options.mainPath;
  result.workers_dev = true; result.preview_urls = false;
  const vars = record(config.vars);
  if (Object.values(vars).some((value) => typeof value !== "string") || Object.keys(vars).some((key) => /(?:SECRET|TOKEN|PASSWORD|API_KEY)$/.test(key))) {
    throw new Error("runtime-candidate-plaintext-secrets-or-vars-invalid");
  }
  result.vars = { ...vars } as Record<string, string>;
  // A private candidate must execute the coordinator body instead of returning
  // at the production storage-ownership gate. No regular event trigger is kept.
  delete result.vars.EOD_STORAGE_MIGRATION_ID;
  Object.assign(result.vars, { EOD_RUNTIME_CANDIDATE_ONLY: "true", EOD_RUNTIME_PROBE_ID: identity.probeId,
    EOD_RUNTIME_PROBE_UNTIL: options.probeUntil, EOD_RUNTIME_TARGET_DATABASE_ID: identity.targetDatabaseId,
    EOD_CODE_REVISION: identity.codeRevision, EOD_READ_ENABLED: "true", EOD_RUNNER_MODE: "active",
    EOD_ARCHIVE_PRUNE_ENABLED: "false", ADMIN_AUTH_FAIL_CLOSED: "true", SCANNER_CACHE_QUEUE_ENABLED: "false" });
  const expected = { DB: identity.coreDatabaseId, MARKET_DATA_DB: identity.sourceDatabaseId,
    MARKET_HISTORY_DB: identity.historyDatabaseId, OPS_DB: identity.opsDatabaseId };
  if (!Array.isArray(config.d1_databases)) throw new Error("runtime-candidate-database-bindings-required");
  const seen = new Set<string>();
  result.d1_databases = config.d1_databases.map((entry) => {
    const binding = record(entry), name = binding.binding;
    if (typeof name !== "string" || seen.has(name) || typeof binding.database_id !== "string" || !uuid.test(binding.database_id)) throw new Error("runtime-candidate-database-binding-invalid");
    seen.add(name);
    if (Object.hasOwn(expected, name) && binding.database_id !== expected[name as keyof typeof expected]) throw new Error(`runtime-candidate-reviewed-binding-mismatch:${name}`);
    const copied = { ...binding };
    delete copied.migrations_dir; delete copied.migrations_table; delete copied.preview_database_id; delete copied.remote;
    if (name === "MARKET_DATA_DB") { copied.database_id = identity.targetDatabaseId; copied.database_name = `runtime-target-${identity.targetDatabaseId}`; }
    return copied;
  });
  if (Object.keys(expected).some((name) => !seen.has(name))) throw new Error("runtime-candidate-required-binding-missing");
  result.version_metadata = { binding: "EOD_VERSION_METADATA" };
  result.observability = { enabled: true, head_sampling_rate: 1, logs: { enabled: true, invocation_logs: true } };
  return result;
}

/** This parser returns only ADMIN_SECRET. Other local provider credentials are
 * never selected, copied or printed. No interpolation or shell evaluation. */
export function localRuntimeAdminSecret(text: string): string | null {
  if (text.length > 256_000) throw new Error("runtime-candidate-local-secret-file-too-large");
  const rows = text.split(/\r?\n/).filter((line) => /^\s*(?:export\s+)?ADMIN_SECRET\s*=/.test(line));
  if (!rows.length) return null;
  if (rows.length !== 1) throw new Error("runtime-candidate-admin-secret-ambiguous");
  let value = rows[0].replace(/^\s*(?:export\s+)?ADMIN_SECRET\s*=\s*/, "").trim();
  if (value.startsWith('"')) { try { value = JSON.parse(value) as string; } catch { throw new Error("runtime-candidate-admin-secret-invalid"); } }
  else if (value.startsWith("'")) { if (!value.endsWith("'")) throw new Error("runtime-candidate-admin-secret-invalid"); value = value.slice(1, -1); }
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error("runtime-candidate-admin-secret-invalid");
  return value;
}

export type CandidateProbeState = { from: number; to: number | null; probes: Array<{
  route: string; status: "started" | "ok" | "failed"; startedAt: string; finishedAt?: string;
}> };
export async function runCandidateProbes(input: { identity: CandidateIdentity; baseUrl: string; adminSecret: string;
  state: CandidateProbeState; save: (state: CandidateProbeState) => Promise<void>; assertEligible: () => Promise<void>;
  assertCurrentVersion: () => Promise<void>; fetcher?: typeof fetch; now?: () => Date;
}): Promise<CandidateProbeState> {
  const base = new URL(input.baseUrl), clock = input.now ?? (() => new Date()), state = structuredClone(input.state);
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash
    || !base.hostname.startsWith(input.identity.workerName + ".") || !base.hostname.endsWith(".workers.dev") || !input.adminSecret) throw new Error("runtime-candidate-probe-origin-invalid");
  const routes = [EOD_RUNTIME_HTTP_PATHS[0], EOD_RUNTIME_HTTP_PATHS[0], EOD_RUNTIME_HTTP_PATHS[1], EOD_RUNTIME_HTTP_PATHS[1], EOD_RUNTIME_COORDINATOR_PATH];
  if (state.probes.length > routes.length || state.probes.some((probe, index) => probe.route !== routes[index] || probe.status !== "ok")) {
    throw new Error("runtime-candidate-interrupted-probe-collect-or-new-attempt");
  }
  await input.assertEligible(); await input.assertCurrentVersion();
  for (let index = state.probes.length; index < routes.length; index++) {
    const route = routes[index], probe: CandidateProbeState["probes"][number] = { route, status: "started", startedAt: clock().toISOString() };
    state.probes.push(probe); await input.save(state); // Claim before HTTP; a timeout is never replayed blindly.
    try {
      const response = await (input.fetcher ?? fetch)(new URL(route, base), { method: route === EOD_RUNTIME_COORDINATOR_PATH ? "POST" : "GET",
        headers: { Authorization: `Bearer ${input.adminSecret}`, "x-eod-runtime-probe": input.identity.probeId },
        redirect: "error", signal: AbortSignal.timeout(60_000) });
      if (response.status !== 200 || response.headers.get("x-dashboard-stale-fallback") || !response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel(); throw new Error("runtime-candidate-probe-http-failed");
      }
      const reader = response.body?.getReader(); let bytes = 0;
      if (reader) for (;;) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 16 * 1024 * 1024) { await reader.cancel(); throw new Error("runtime-candidate-response-too-large"); }
      }
      probe.status = "ok"; probe.finishedAt = clock().toISOString(); await input.save(state);
    } catch { probe.status = "failed"; probe.finishedAt = clock().toISOString(); state.to = clock().getTime(); await input.save(state); throw new Error("runtime-candidate-probe-failed-collect-diagnostics"); }
  }
  state.to = clock().getTime(); await input.save(state);
  await input.assertCurrentVersion(); await input.assertEligible();
  return state;
}
