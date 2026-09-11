import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { expectedEodSession } from "../src/eod-coordinator";
import { loadStorageMigration, loadStorageMigrationCheckpoint, storageMigrationIdentity, storageExecutionIdentity } from "../src/market-storage-control";
import { assertStorageExecutionRevision } from "../src/market-storage-execution";
import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { loadStorageValidationPlan } from "../src/market-storage-population-plan";
import { validateStorageValidationBootstrap } from "../src/market-storage-validation-consumers";
import { assertStorageVerificationCapture, type StorageVerificationEvidence } from "../src/market-storage-verification";
import { verifyStorageAcceptedPublications } from "../src/market-storage-acceptance";
import { loadStoragePlanConsumerProof } from "../src/market-storage-consumer-composite";
import { storageHash } from "../src/market-storage-pages";
import { buildRuntimeEvidence, collectRuntimeEvidence, validateRuntimeEvidence, type RuntimeEvidenceIdentity } from "../src/eod-runtime-evidence";
import { buildRuntimeTailEvidence, claimRuntimeTailAttempt, loadRuntimeTailReceipt, RUNTIME_TAIL_ROUTES,
  storeRuntimeTailReceipt, verifyRuntimeLiveVersion, type RuntimeTailAttempt } from "../src/eod-runtime-tail-evidence";
import { openRuntimeLiveTail } from "./eod-runtime-live-tail";
import { assertCandidateMigrationState, privateRuntimeAdminSecret, assertRuntimeCandidateCredentialBinding, prepareRuntimeCandidateConfig, runCandidateProbes, runtimeCandidateIdentity,
  runtimeCandidatePublicationHash,
  assertRuntimeCandidateWindow, runtimeCandidateRequiresWindow,
  type CandidateIdentity, type CandidateProbeState } from "../src/eod-runtime-candidate";
import type { Env } from "../src/types";

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."), repoRoot = resolve(workerRoot, "..");
const required = (key: string): string => { const value = process.env[key]?.trim(); if (!value) throw new Error(`runtime-candidate-missing:${key}`); return value; };
const git = (...args: string[]) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
type State = { version: 1; identity: CandidateIdentity; configHash: string; publicationHash: string; validationPlanHash: string; probeUntil: string; deploymentAttempted: boolean;
  collectionMode?: "telemetry" | "live-tail";
  secretsInstalled?: boolean; candidateCredentialHash?: string; workerVersion?: string; baseUrl?: string; samples?: CandidateProbeState };
async function main(): Promise<void> {
  const command = process.argv[2] ?? "run";
  if (!["prepare", "run", "collect"].includes(command)) throw new Error("runtime-candidate-command-invalid");
  const collectionMode = process.env.EOD_RUNTIME_COLLECTION_MODE ?? "telemetry";
  if (collectionMode !== "telemetry" && collectionMode !== "live-tail") throw new Error("runtime-candidate-collection-mode-invalid");
  if (git("status", "--porcelain").length) throw new Error("runtime-candidate-clean-committed-checkout-required");
  const codeRevision = git("rev-parse", "HEAD"), accountId = required("CLOUDFLARE_ACCOUNT_ID"), token = required("CLOUDFLARE_API_TOKEN");
  const d1Token = process.env.CLOUDFLARE_EOD_D1_TOKEN || token, migrationId = required("EOD_STORAGE_MIGRATION_ID");
  const sourceId = process.env.EOD_STORAGE_SOURCE_DATABASE_ID || required("EOD_MARKET_DATABASE_ID"), targetId = required("EOD_STORAGE_TARGET_DATABASE_ID"),
    historyId = required("EOD_HISTORY_DATABASE_ID"), opsId = required("EOD_OPS_DATABASE_ID"), coreId = required("EOD_CORE_DATABASE_ID");
  const allowedDatabaseIds = [sourceId, targetId, historyId, opsId, coreId];
  if (!/^[a-f0-9]{32}$/.test(accountId) || new Set(allowedDatabaseIds).size !== 5) throw new Error("runtime-candidate-account-or-databases-invalid");
  const rawOps = createEodD1Database({ accountId, token: d1Token, databaseId: opsId, allowedDatabaseIds });
  const budgetProfile = resolveEodBudgetProfile(process.env.EOD_BUDGET_PROFILE);
  const admission = createEodAdmission(rawOps, `runtime-prepare:${migrationId}`, { readCredit: 50_000, writeCredit: 500, profile:budgetProfile,
    reconcileAccountUsage: () => reconcileEodAccountUsage({ accountId, token: process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token, ops: rawOps, profile:budgetProfile }) });
  const database = (databaseId: string) => createEodD1Database({ accountId, token: d1Token, databaseId, allowedDatabaseIds, admission });
  const env: Env = { DB: database(coreId), MARKET_DATA_DB: database(targetId), MARKET_HISTORY_DB: database(historyId), OPS_DB: database(opsId),
    EOD_CODE_REVISION: codeRevision, EOD_BUDGET_PROFILE:budgetProfile.name, EOD_RUNNER_MODE: "active", EOD_READ_ENABLED: "true", EOD_ARCHIVE_PRUNE_ENABLED: "false", ALPACA_DAILY_FEED: "sip" };
  const source = database(sourceId);
  try {
    const initial = await loadStorageMigration(env.OPS_DB!, migrationId);
    if (!initial || initial.source_database_id !== sourceId || initial.target_database_id !== targetId
      || initial.history_database_id !== historyId) throw new Error("runtime-candidate-migration-identity-conflict");
    await assertStorageExecutionRevision(env.OPS_DB!,initial,codeRevision);
    const captureIdentity = storageMigrationIdentity(initial), migration = storageExecutionIdentity(initial);
    const eligible = async (session?: string): Promise<{ session: string; publicationHash: string; validationPlanHash: string }> => {
      const current = await loadStorageMigration(env.OPS_DB!, migrationId);
      if (!current) throw new Error("runtime-candidate-migration-missing");
      await assertStorageExecutionRevision(env.OPS_DB!,current,codeRevision);
      assertCandidateMigrationState(current, migration);
      const plan = await loadStorageValidationPlan(env.OPS_DB!, current);
      const verified = await loadStorageMigrationCheckpoint(env.OPS_DB!, migrationId, "verification:complete"), capture = verified?.payload as StorageVerificationEvidence | undefined;
      if (!capture || capture.schemaVersion !== 1 || !capture.verified || capture.captureHash !== verified?.inputHash
        || await storageHash(capture.identity) !== await storageHash(captureIdentity) || capture.sourceCapture.schemaHash !== current.source_schema_hash
        || capture.sourceCapture.revision !== current.source_revision || capture.captureHash !== plan.originalCopyCaptureHash) throw new Error("runtime-candidate-whole-copy-required");
      await assertStorageVerificationCapture(source, captureIdentity, capture.sourceCapture);
      await loadStoragePlanConsumerProof(env.OPS_DB!, current, plan);
      const complete = await loadStorageMigrationCheckpoint(env.OPS_DB!, migrationId, "bootstrap:complete"), owner = await loadStorageMigrationCheckpoint(env.OPS_DB!, migrationId, "bootstrap:owner");
      const expected = await expectedEodSession(env);
      if (!expected || (session && session !== expected)) throw new Error("runtime-candidate-completed-latest-bootstrap-required");
      const completed = await validateStorageValidationBootstrap(plan, { complete, owner, targetDatabaseId: targetId, expectedSession: expected });
      const publications = await verifyStorageAcceptedPublications({ env, identity: migration, runId: completed.runId, tickers: plan.tickers, expectedSession: expected });
      await assertStorageVerificationCapture(source, captureIdentity, capture.sourceCapture);
      return { session: expected, publicationHash: await runtimeCandidatePublicationHash(publications), validationPlanHash: plan.planHash };
    };
    const ready = await eligible();
    const identity = await runtimeCandidateIdentity({ migration, sessionDate: ready.session, opsDatabaseId: opsId, coreDatabaseId: coreId,
      attempt: Number(process.env.EOD_RUNTIME_ATTEMPT ?? "1"), budgetProfile:budgetProfile.name });
    const directory = resolve(workerRoot, "tmp", identity.workerName), statePath = resolve(directory, "state.json"), configPath = resolve(directory, "wrangler.jsonc");
    const assertCoordinatorWindow = async (): Promise<void> => {
      const now = new Date();
      const session = await env.MARKET_DATA_DB!.prepare("SELECT session_date AS sessionDate,close_at AS closeAt FROM market_calendar_sessions WHERE session_date=?")
        .bind(ready.session).first<{ sessionDate: string; closeAt: string }>();
      assertRuntimeCandidateWindow(now, session);
    };
    const savedState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) as State : undefined;
    // Measure real current-time coordinator execution once the latest accepted
    // session is eligible; overnight recovery does not require an opening bell.
    if (runtimeCandidateRequiresWindow(command as "prepare" | "run" | "collect", savedState)) await assertCoordinatorWindow();
    mkdirSync(directory, { recursive: true });
    const persist = (value: State) => { const pending = statePath + ".pending"; writeFileSync(pending, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); renameSync(pending, statePath); };
    let state: State;
    if (savedState) {
      state = savedState;
      if ((state.collectionMode ?? "telemetry") !== collectionMode || state.version !== 1 || state.publicationHash !== ready.publicationHash || state.validationPlanHash !== ready.validationPlanHash || await storageHash(state.identity) !== await storageHash(identity)
        || !existsSync(configPath) || await storageHash(JSON.parse(readFileSync(configPath, "utf8"))) !== state.configHash) throw new Error("runtime-candidate-saved-config-integrity");
    } else {
      if (command === "collect") throw new Error("runtime-candidate-existing-deployment-required");
      const probeUntil = new Date(Date.now() + 2 * 3600_000).toISOString();
      const config = prepareRuntimeCandidateConfig(parse(readFileSync(resolve(workerRoot, "wrangler.toml"), "utf8")), identity,
        { mainPath: resolve(workerRoot, "src/index.ts"), probeUntil });
      state = { version: 1, identity, collectionMode, configHash: await storageHash(config), publicationHash: ready.publicationHash,
        validationPlanHash: ready.validationPlanHash, probeUntil, deploymentAttempted: false };
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 }); persist(state);
    }
    if (command === "prepare") { console.log(JSON.stringify({ status: "candidate-prepared", workerName: identity.workerName, configPath, session: ready.session })); return; }
    const assertSamePublications = async (): Promise<void> => {
      const current = await eligible(identity.sessionDate);
      if (current.publicationHash !== state.publicationHash || current.validationPlanHash !== state.validationPlanHash) throw new Error("runtime-candidate-publications-changed-new-attempt-required");
    };
    const api = async (path: string, allowMissing = false): Promise<Record<string, unknown> | null> => {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
      if (allowMissing && response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`runtime-candidate-control-http-${response.status}`); }
      const body = await response.json() as { success?: boolean; result?: Record<string, unknown> };
      if (!body.success || !body.result) throw new Error("runtime-candidate-control-response-invalid"); return body.result;
    };
    const wrangler = (args: string[], stdin?: string) => {
      try { execFileSync(process.execPath, [resolve(repoRoot, "node_modules/wrangler/bin/wrangler.js"), ...args], {
        cwd: workerRoot, env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId, CI: "true" },
        input: stdin, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: 300_000, maxBuffer: 8_000_000,
      }); } catch { throw new Error(`runtime-candidate-wrangler-${args[0]}-failed`); }
    };
    // The independent candidate never receives production's ADMIN_SECRET.
    // Only the credential fingerprint is persisted; collection needs no secret.
    const adminSecret = command === "run" ? await privateRuntimeAdminSecret(token, accountId, identity) : null;
    if (adminSecret) {
      const candidateCredentialHash = await storageHash(adminSecret);
      assertRuntimeCandidateCredentialBinding(candidateCredentialHash, state);
      if (!state.candidateCredentialHash) { state.candidateCredentialHash = candidateCredentialHash; persist(state); }
    }
    if (!state.secretsInstalled && command !== "collect") {
      if (state.workerVersion || state.samples) throw new Error("runtime-candidate-secret-install-state-conflict");
      if (!state.deploymentAttempted) {
      const existing = await api(`/workers/scripts/${identity.workerName}/settings`, true);
      if (existing) throw new Error("runtime-candidate-name-already-exists");
      }
      if (Date.parse(state.probeUntil) <= Date.now()) throw new Error("runtime-candidate-expired-new-attempt-required");
      let githubToken = process.env.EOD_GITHUB_TOKEN;
      if (!githubToken) { try { githubToken = execFileSync("gh", ["auth", "token", "--hostname", "github.com"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { throw new Error("runtime-candidate-github-secret-required"); } }
      if (!githubToken) throw new Error("runtime-candidate-github-secret-required");
      const secrets: Record<string, string> = { ADMIN_SECRET: adminSecret!, EOD_GITHUB_TOKEN: githubToken };
      if (process.env.ALPACA_API_KEY && process.env.ALPACA_API_SECRET) { secrets.ALPACA_API_KEY = process.env.ALPACA_API_KEY; secrets.ALPACA_API_SECRET = process.env.ALPACA_API_SECRET; }
      await assertSamePublications();
      await assertCoordinatorWindow();
      wrangler(["whoami"]);
      if (!state.deploymentAttempted) {
        wrangler(["deploy", "--dry-run", "--config", configPath]);
        await assertCoordinatorWindow();
        state.deploymentAttempted = true; persist(state);
        wrangler(["deploy", "--config", configPath]);
      }
      // Secret payload is a pipe, never a CLI argument or a file. Do not forward stdout/stderr.
      wrangler(["secret", "bulk", "--config", configPath], JSON.stringify(secrets));
      state.secretsInstalled = true; persist(state);
    }
    const deployed = async (): Promise<string> => {
      const current = await api(`/workers/scripts/${identity.workerName}/deployments`);
      const deployment = (current?.deployments as Array<{ id?: string; versions?: Array<{ version_id?: string; percentage?: number }> }> | undefined)?.[0];
      const version = deployment?.versions?.[0];
      if (deployment?.versions?.length !== 1 || version?.percentage !== 100 || !version.version_id) throw new Error("runtime-candidate-exclusive-deployment-required");
      const actual = await api(`/workers/scripts/${identity.workerName}/versions/${version.version_id}`);
      const expected: RuntimeEvidenceIdentity = { probeId: identity.probeId, workerName: identity.workerName, workerVersion: version.version_id,
        codeRevision, targetDatabaseId: targetId, historyDatabaseId: historyId, opsDatabaseId: opsId, coreDatabaseId: coreId, budgetProfile:budgetProfile.name };
      await buildRuntimeEvidence(expected, actual, [], { from: Date.now() - 1000, to: Date.now() }, true);
      const bindings = (actual?.resources as { bindings?: Array<{ name: string; type: string; text?: string }> })?.bindings ?? [];
      if (bindings.filter((row) => row.name === "EOD_RUNNER_MODE" && row.type === "plain_text" && row.text === "active").length !== 1
        || bindings.some((row) => row.name === "EOD_STORAGE_MIGRATION_ID")
        || !["ADMIN_SECRET", "EOD_GITHUB_TOKEN"].every((name) => bindings.some((row) => row.name === name && row.type === "secret_text"))) throw new Error("runtime-candidate-coordinator-or-secret-bindings-invalid");
      return version.version_id;
    };
    const currentVersion = await deployed();
    if (state.workerVersion && state.workerVersion !== currentVersion) throw new Error("runtime-candidate-deployment-changed");
    state.workerVersion = currentVersion;
    const account = await api("/workers/subdomain"), subdomain = account?.subdomain;
    if (typeof subdomain !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(subdomain)) throw new Error("runtime-candidate-workers-subdomain-invalid");
    state.baseUrl = `https://${identity.workerName}.${subdomain}.workers.dev`; persist(state);
    const runtimeIdentity: RuntimeEvidenceIdentity = { probeId: identity.probeId, workerName: identity.workerName, workerVersion: state.workerVersion!, codeRevision,
      targetDatabaseId: targetId, historyDatabaseId: historyId, opsDatabaseId: opsId, coreDatabaseId: coreId, budgetProfile:budgetProfile.name };
    let evidence;
    if (collectionMode === "live-tail") {
      try {
        evidence = await loadRuntimeTailReceipt(env.OPS_DB!, runtimeIdentity, state);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "runtime-tail-durable-receipt-missing") throw error;
        if (command !== "run" || state.samples?.probes.length) throw new Error("runtime-tail-receipt-missing-new-candidate-required");
        if (Date.parse(state.probeUntil) <= Date.now()) throw new Error("runtime-candidate-expired-new-attempt-required");
        await assertCoordinatorWindow(); await assertSamePublications();
        const stream = await openRuntimeLiveTail({ accountId, token, identity: runtimeIdentity });
        try {
          const attempt: RuntimeTailAttempt = { version: 1, identity: runtimeIdentity,
            publicationHash: state.publicationHash, validationPlanHash: state.validationPlanHash,
            connectedAt: stream.connectedAt, probeUntil: state.probeUntil,
            requests: RUNTIME_TAIL_ROUTES.map(route => ({ route, nonce: crypto.randomUUID() })) };
          await claimRuntimeTailAttempt(env.OPS_DB!, attempt);
          state.samples = { from: Date.now(), to: null, probes: [] }; persist(state);
          state.samples = await runCandidateProbes({ identity, baseUrl: state.baseUrl, adminSecret: adminSecret!, state: state.samples,
            liveRequests: attempt.requests, assertStreamHealthy: stream.assertHealthy,
            save: async samples => { state.samples = structuredClone(samples); persist(state); }, assertEligible: assertSamePublications,
            assertCurrentVersion: async () => { await verifyRuntimeLiveVersion({ accountId, token, identity: runtimeIdentity }); } });
          const events = await stream.waitForFive(); state.samples.to = Date.now(); persist(state);
          stream.assertHealthy();
          const closedAt = await stream.close();
          await assertSamePublications();
          const version = await verifyRuntimeLiveVersion({ accountId, token, identity: runtimeIdentity });
          evidence = await buildRuntimeTailEvidence({ identity: runtimeIdentity, version, attempt, events,
            responses: state.samples.probes.map(probe => ({ nonce: probe.nonce!, requestId: probe.requestId! })),
            window: { from: state.samples.from, to: state.samples.to }, closedAt });
          evidence = await storeRuntimeTailReceipt(env.OPS_DB!, evidence);
        } finally { await stream.close(); }
      }
    }
    if (collectionMode === "telemetry" && command === "run" && (!state.samples || (state.samples.probes.length < 5 && state.samples.probes.every((probe) => probe.status === "ok")))) {
      if (Date.parse(state.probeUntil) <= Date.now()) throw new Error("runtime-candidate-expired-new-attempt-required");
      await assertCoordinatorWindow();
      state.samples ??= { from: Date.now(), to: null, probes: [] }; persist(state);
      try {
        state.samples = await runCandidateProbes({ identity, baseUrl: state.baseUrl, adminSecret: adminSecret!, state: state.samples,
          save: async (samples) => { state.samples = structuredClone(samples); persist(state); },
          assertEligible: assertSamePublications,
          assertCurrentVersion: async () => { if (await deployed() !== state.workerVersion) throw new Error("runtime-candidate-deployment-changed"); } });
      } catch { console.log(JSON.stringify({ status: "candidate-probe-incomplete", workerName: identity.workerName, inspect: "bounded-runtime-evidence" })); }
    }
    if (collectionMode === "telemetry") {
      if (!state.samples?.probes.length) throw new Error("runtime-candidate-probes-required");
      state.samples.to ??= Date.now(); persist(state);
      for (let attempt = 0; attempt < 5; attempt++) {
      try { evidence = await collectRuntimeEvidence({ accountId, token, identity: runtimeIdentity, from: state.samples.from, to: state.samples.to }); }
      catch (error) { if (attempt === 4 || (error instanceof Error && /http-(401|403|429)/.test(error.message))) throw error; }
      if (evidence?.complete) break;
      if (attempt < 4) await new Promise((done) => setTimeout(done, 10_000));
      }
    }
    if (!evidence) throw new Error("runtime-candidate-raw-evidence-unavailable");
    if (evidence.complete) { await validateRuntimeEvidence(evidence, runtimeIdentity); await assertSamePublications(); if (await deployed() !== state.workerVersion) throw new Error("runtime-candidate-deployment-changed"); }
    const output = process.env.EOD_STORAGE_RUNTIME_EVIDENCE_PATH || required("EOD_RUNTIME_EVIDENCE_PATH");
    // Never replace an accepted artifact with a failed attempt. A pending file
    // can be refreshed as raw logs arrive for the exact same probe identity.
    if (existsSync(output)) {
      const previous = JSON.parse(readFileSync(output, "utf8")) as { complete?: boolean; identity?: unknown };
      if (await storageHash(previous.identity) !== await storageHash(runtimeIdentity)) throw new Error("runtime-candidate-output-identity-conflict");
      if (previous.complete) {
        await validateRuntimeEvidence(previous, runtimeIdentity);
        console.log(JSON.stringify({ status: evidence.complete ? "candidate-evidence-already-complete" : "candidate-runtime-reverification-pending",
          workerName: identity.workerName, unavailableReasons: evidence.unavailableReasons }));
        if (!evidence.complete) process.exitCode = 2;
        return;
      }
    }
    writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ status: evidence.complete ? "candidate-runtime-verified" : "candidate-runtime-pending", workerName: identity.workerName,
      session: identity.sessionDate, evidenceHash: evidence.evidenceHash, measurements: evidence.measurements, unavailableReasons: evidence.unavailableReasons }));
    if (!evidence.complete) process.exitCode = 2;
  } finally { await admission.flush(); }
}

main().catch((error) => { console.error(error instanceof Error && /^[A-Za-z0-9:._;/ -]{1,200}$/.test(error.message) ? error.message : "runtime-candidate-operation-failed"); process.exitCode = 1; });
