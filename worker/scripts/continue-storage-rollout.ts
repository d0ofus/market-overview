import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { fetchEodAccountUsage, reconcileEodAccountUsage } from "../src/eod-account-usage";
import { localRecoveryChildReason, localRecoveryFailure, localRecoveryRequiresBootstrapRefresh, parseLocalPopulationSizing, runLocalStorageRecovery, type LocalRecoveryResult } from "../src/eod-local-recovery";
import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { assertStorageExecutionRevision } from "../src/market-storage-execution";
import { loadStorageMigration } from "../src/market-storage-control";
import { storeEodControllerReport, type EodControllerReport } from "../src/eod-recovery-status";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = resolve(root, "worker/tmp");
const configuration = z.object({ version: z.literal(1), codeRevision: z.string().regex(/^[a-f0-9]{40}$/),
  migrationId: z.string().regex(/^market-storage:[A-Za-z0-9._:-]+$/).optional(), storageCodeRevision: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  budgetProfile: z.enum(["free","paid"]).optional(),
  afterUtc: z.string().datetime(), accountId: z.string().regex(/^[a-f0-9]{32}$/), sourceDatabaseId: z.string().uuid(),
  historyDatabaseId: z.string().uuid(), opsDatabaseId: z.string().uuid(), coreDatabaseId: z.string().uuid(),
  snapshotPath: z.string(), historySnapshotPath: z.string(), frozenRunId: z.string().regex(/^eod:shadow:\d{4}-\d{2}-\d{2}:daily$/),
  autoActivate: z.literal(true) }).strict();
const safeFile = (value: string) => {
  const path = resolve(root, value), rel = relative(tmp, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("storage-local-artifact-outside-workspace");
  return path;
};
const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));

async function main(): Promise<void> {
  const input = configuration.parse(read(safeFile(process.argv[2] ?? "worker/tmp/storage-recovery-config.json")));
  if (new Set([input.sourceDatabaseId,input.historyDatabaseId,input.opsDatabaseId,input.coreDatabaseId]).size !== 4) throw new Error("storage-local-database-identity-conflict");
  const snapshot = safeFile(input.snapshotPath), historySnapshot = safeFile(input.historySnapshotPath);
  const statePath = resolve(tmp, "storage-recovery-status.json"), lockPath = resolve(tmp, "storage-recovery.lock");
  const logPath = resolve(tmp, "storage-recovery.log");
  mkdirSync(tmp, { recursive: true });
  const now = new Date();
  const previous = existsSync(statePath) ? read(statePath) as LocalRecoveryResult & { codeRevision?: string } : null;
  if (previous?.codeRevision === input.codeRevision && (previous.status === "paused"
    || (previous.status === "waiting" && previous.nextAttemptAt && Date.parse(previous.nextAttemptAt) > now.getTime()))) {
    console.log(JSON.stringify({ status: previous.status, stage: previous.stage, nextAttemptAt: previous.nextAttemptAt, reason: previous.reason })); return;
  }
  let reportOps: D1Database | undefined, pendingReport: EodControllerReport | undefined;
  const publish = async () => {
    if (!reportOps || !pendingReport) return;
    try { await storeEodControllerReport(reportOps, pendingReport); }
    catch { console.log(JSON.stringify({ status: "recovery-status-sync-pending" })); }
  };
  const save = (result: LocalRecoveryResult | { status: "running"; stage: string; nextAttemptAt: null; reason: string }) => {
    const temporary = statePath + ".next";
    pendingReport = { version: 1, ...result, codeRevision: input.codeRevision, updatedAt: new Date().toISOString() };
    writeFileSync(temporary, JSON.stringify({ ...pendingReport, pid: process.pid }, null, 2));
    renameSync(temporary, statePath);
    console.log(JSON.stringify(result));
  };
  if (now.getTime() < Date.parse(input.afterUtc)) {
    save({ status: "waiting", stage: "utc-reset", nextAttemptAt: input.afterUtc, reason: "storage-local-quota-deferred" }); return;
  }
  // The scheduled task rejects concurrent instances. This additionally protects
  // manual CLI invocations; an orphan lock can expire after the maximum attempt.
  if (existsSync(lockPath)) {
    const prior = read(lockPath) as { createdAt: string; pid: number };
    let alive = false;
    try { process.kill(prior.pid,0); alive = true; } catch { /* A restart leaves an orphan lock. */ }
    if (alive && now.getTime() - Date.parse(prior.createdAt) < 90 * 60_000) throw new Error("storage-local-attempt-already-running");
    unlinkSync(lockPath);
  }
  const lock = openSync(lockPath, "wx"); writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: now.toISOString() })); closeSync(lock);
  let stage = "preflight";
  const command = (executable: string, args: string[], env: NodeJS.ProcessEnv = process.env): string => {
    try {
      const output = execFileSync(executable, args, { cwd: root, env, encoding: "utf8", windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"], timeout: 20 * 60_000, maxBuffer: 16_000_000 });
      appendFileSync(logPath, output); return output.trim();
    } catch (error) {
      const native = error as { stdout?: string; stderr?: string; code?: string };
      const detail = String(native.stdout ?? "") + String(native.stderr ?? "");
      // Only sanitized fixed categories leave failed native processes.
      const knownReason = localRecoveryChildReason(detail);
      if (knownReason) throw new Error(knownReason);
      if (localRecoveryRequiresBootstrapRefresh(detail)) throw new Error("storage-local-bootstrap-refresh-required");
      if (/quota|budget|daily-read|daily-write|maximum.*rows|exceeded.*rows/i.test(detail)) throw new Error("storage-local-budget-exhausted");
      if (/timeout|network|unavailable|runtime-evidence-incomplete|runtime-pending|logs.*pending|measurement-window-required|await-actual-coordinator-window/i.test(detail) || native.code === "ETIMEDOUT") throw new Error("storage-local-transient-unavailable");
      throw new Error(`storage-local-${stage}-failed`);
    }
  };
  const token = process.env.CLOUDFLARE_EOD_D1_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (!token || !process.env.CLOUDFLARE_API_TOKEN) { unlinkSync(lockPath); throw new Error("storage-local-credential-unavailable"); }
  const sessionDate = input.frozenRunId.split(":")[2], storageCodeRevision = input.storageCodeRevision ?? input.codeRevision;
  const migrationId = input.migrationId ?? `market-storage:${sessionDate}:${storageCodeRevision.slice(0,12)}`;
  const profile = resolveEodBudgetProfile(input.budgetProfile ?? process.env.EOD_BUDGET_PROFILE);
  const env: NodeJS.ProcessEnv = { ...process.env, EOD_BUDGET_PROFILE: profile.name, CLOUDFLARE_ACCOUNT_ID: input.accountId, CLOUDFLARE_EOD_D1_TOKEN: token,
    EOD_MARKET_DATABASE_ID: input.sourceDatabaseId, EOD_STORAGE_SOURCE_DATABASE_ID: input.sourceDatabaseId,
    EOD_HISTORY_DATABASE_ID: input.historyDatabaseId, EOD_OPS_DATABASE_ID: input.opsDatabaseId, EOD_CORE_DATABASE_ID: input.coreDatabaseId,
    EOD_STORAGE_MIGRATION_ID: migrationId, EOD_SNAPSHOT_RUN_ID: input.frozenRunId, STORAGE_SNAPSHOT_PATH: snapshot,
    EOD_STORAGE_START_APPROVED: "true", EOD_STORAGE_ACTIVATE_APPROVED: "true", EOD_STORAGE_EXPECTED_COMMIT: input.codeRevision,
    EOD_STORAGE_SNAPSHOT_IDENTITY_PATH: snapshot + ".identity.json", EOD_STORAGE_FROZEN_INPUT_PATH: snapshot + ".tickers.json",
    EOD_STORAGE_ANALYSIS_PATH: resolve(tmp,"eod-storage-analysis.json") };
  const node = (script: string, args: string[] = []) => command(process.execPath, [resolve(root,"node_modules/tsx/dist/cli.mjs"),resolve(root,"worker/scripts",script),...args],env);
  const assertCheckout = async () => {
    if (command("git",["rev-parse","HEAD"]) !== input.codeRevision || command("git",["branch","--show-current"]) !== "main"
      || command("git",["status","--porcelain","--untracked-files=no"])) throw new Error("storage-local-checkout-changed");
  };
  let admission: ReturnType<typeof createEodAdmission> | undefined;
  try {
    await assertCheckout();
    const usage = await fetchEodAccountUsage({ accountId: input.accountId, token: process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token, usageDate: now.toISOString().slice(0,10) });
    if (usage.rowsRead >= profile.accountDaily.reads || usage.rowsWritten >= profile.accountDaily.writes) throw new Error("storage-local-budget-exhausted");
    const allowedDatabaseIds = [input.sourceDatabaseId,input.historyDatabaseId,input.opsDatabaseId,input.coreDatabaseId];
    const rawOps = createEodD1Database({ accountId: input.accountId,token,databaseId: input.opsDatabaseId,allowedDatabaseIds });
    admission = createEodAdmission(rawOps,`local-recovery:${migrationId}`, { profile, reconcileAccountUsage: () => reconcileEodAccountUsage({
      accountId: input.accountId,token: process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token,ops: rawOps,profile }) });
    const ops = createEodD1Database({ accountId: input.accountId,token,databaseId: input.opsDatabaseId,allowedDatabaseIds,admission });
    reportOps = ops;
    const phase = async (name: string) => {
      if (Date.now()-now.getTime()>35*60_000) throw new Error("storage-local-attempt-timeout");
      stage = name; save({ status: "running", stage, reason: "", nextAttemptAt: null });
      await publish();
    };
    const variables = () => {
      const body = JSON.parse(command("gh",["api","repos/d0ofus/market-overview/environments/market-eod/variables?per_page=100"])) as { total_count: number; variables: {name:string;value:string}[] };
      if (body.total_count !== body.variables.length) throw new Error("storage-local-github-variables-incomplete");
      return new Map(body.variables.map(row => [row.name,row.value]));
    };
    const target = () => {
      const vars = variables(), id = vars.get("EOD_STORAGE_TARGET_DATABASE_ID");
      if (!id) return null;
      if (vars.get("EOD_STORAGE_CODE_REVISION") !== storageCodeRevision
        || (vars.get("EOD_STORAGE_EXECUTION_REVISION") ?? storageCodeRevision) !== input.codeRevision || vars.get("EOD_STORAGE_SOURCE_DATABASE_ID") !== input.sourceDatabaseId
        || !z.string().uuid().safeParse(id).success || allowedDatabaseIds.includes(id)) throw new Error("storage-local-github-identity-conflict");
      env.EOD_STORAGE_TARGET_DATABASE_ID = id; return id;
    };
    const coordinatorStarted = async () => {
      const targetId = target(); if (!targetId) return false;
      const base = `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/workers/scripts/market-command-worker`;
      const api = async (suffix: string) => {
        const response = await fetch(base+suffix,{headers:{Authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`},signal:AbortSignal.timeout(15_000)});
        if (!response.ok) throw new Error("storage-local-cloudflare-unavailable");
        const body = await response.json() as {success:boolean;result:unknown};
        if (!body.success) throw new Error("storage-local-cloudflare-unavailable"); return body.result;
      };
      const deployments = await api("/deployments") as {deployments:Array<{id:string;versions:Array<{version_id:string;percentage:number}>}>};
      const selected = deployments.deployments[0];
      if (selected?.versions.length !== 1 || selected.versions[0].percentage !== 100) throw new Error("storage-local-serving-version-ambiguous");
      const version = await api(`/versions/${selected.versions[0].version_id}`) as {resources:{bindings:Array<{name:string;type:string;text?:string;id?:string;database_id?:string}>}};
      const bindings = new Map(version.resources.bindings.map(row=>[row.name,row]));
      const market = bindings.get("MARKET_DATA_DB");
      const actualId = market?.database_id ?? market?.id;
      if (actualId === targetId) return true; // The activation CLI verifies the full target identity before continuing.
      if (actualId !== input.sourceDatabaseId) throw new Error("storage-local-serving-database-conflict");
      return bindings.get("EOD_STORAGE_MIGRATION_ID")?.text === migrationId;
    };
    const populationInputs = async () => {
      env.EOD_STORAGE_POPULATION_PLAN_PATH = resolve(tmp,"storage-population-plan.json");
      node("market-storage-runner.ts",["population-inputs"]);
      const plan = await parseLocalPopulationSizing(read(env.EOD_STORAGE_POPULATION_PLAN_PATH), {
        migrationId, codeRevision: input.codeRevision, originalSessionDate: sessionDate,
      });
      const directory = resolve(tmp,`storage-population-${plan.planHash}`);
      mkdirSync(directory,{recursive:true});
      const tickerPath = resolve(directory,"tickers.json"), payload = JSON.stringify({ tickers: plan.tickers });
      if (existsSync(tickerPath) && readFileSync(tickerPath,"utf8") !== payload) throw new Error("storage-local-population-artifact-conflict");
      if (!existsSync(tickerPath)) writeFileSync(tickerPath,payload);
      // The original .tickers.json remains bound to the frozen source capture.
      // New population sizing gets its own immutable plan-specific artifact.
      return { plan, tickerPath, directory };
    };
    const result = await runLocalStorageRecovery({ assertCheckout,
      hasStarted: coordinatorStarted,
      hasCompleteSnapshot: async () => existsSync(snapshot + ".metadata.json") && (read(snapshot + ".metadata.json") as {complete?:boolean}).complete === true,
      capture: async () => { await phase("capture"); node("market-storage-snapshot.ts"); },
      analyzePreflight: async () => {
        await phase("capacity-analysis"); command("python",[resolve(root,"worker/scripts/analyze-eod-storage.py"),"--source-sqlite",snapshot,
          "--tickers-json",snapshot+".tickers.json","--session-date",sessionDate,"--history-sqlite",historySnapshot,"--output",env.EOD_STORAGE_ANALYSIS_PATH!],env);
      },
      start: async () => { await phase("start"); node("start-storage-migration-once.ts"); if (!target()) throw new Error("storage-local-start-not-persisted"); },
      loadMigration: async () => {
        const run = await loadStorageMigration(ops,migrationId);
        if (!run || run.code_revision !== storageCodeRevision || run.source_database_id !== input.sourceDatabaseId
          || run.target_database_id !== env.EOD_STORAGE_TARGET_DATABASE_ID || run.history_database_id !== input.historyDatabaseId) throw new Error("storage-local-migration-identity-conflict");
        await assertStorageExecutionRevision(ops,run,input.codeRevision);
        return run;
      },
      preparePopulationSizing: async () => {
        await phase("population-inputs");
        const { plan, tickerPath, directory } = await populationInputs();
        env.EOD_STORAGE_ANALYSIS_PATH = resolve(directory,"storage-analysis.json");
        await phase("population-sizing");
        command("python",[resolve(root,"worker/scripts/analyze-eod-storage.py"),"--source-sqlite",snapshot,
          "--tickers-json",tickerPath,"--session-date",plan.sessionDate,"--history-sqlite",historySnapshot,"--output",env.EOD_STORAGE_ANALYSIS_PATH],env);
        await assertCheckout();
        await phase("population-approval"); node("market-storage-runner.ts",["approve-population"]);
        command("gh",["workflow","run","eod-storage-migration.yml","--repo","d0ofus/market-overview","--ref","main","-f",`migration_id=${migrationId}`]);
      },
      prepareAcceptance: async () => {
        await phase("population-inputs");
        const { plan, tickerPath } = await populationInputs();
        await phase("publication-samples");
        env.EOD_STORAGE_PUBLICATION_SAMPLES_PATH = resolve(tmp,"eod-publication-samples.json");
        node("market-storage-runner.ts",["sample-publications"]);
        const samples = read(env.EOD_STORAGE_PUBLICATION_SAMPLES_PATH) as {samplesHash:string;rows:Array<{session_date:string}>};
        if (!/^[a-f0-9]{64}$/.test(samples.samplesHash) || !/^\d{4}-\d{2}-\d{2}$/.test(samples.rows?.[0]?.session_date)
          || samples.rows.some(row=>row.session_date !== samples.rows[0].session_date)) throw new Error("storage-local-publication-samples-invalid");
        const artifactDirectory = resolve(tmp,`storage-acceptance-${input.codeRevision.slice(0,12)}-${samples.rows[0].session_date}-${samples.samplesHash.slice(0,12)}`);
        mkdirSync(artifactDirectory,{recursive:true});
        env.EOD_STORAGE_PUBLICATION_GROWTH_PATH = resolve(artifactDirectory,"publication-growth.json");
        env.EOD_STORAGE_RUNTIME_EVIDENCE_PATH = resolve(artifactDirectory,"runtime-evidence.json");
        env.EOD_STORAGE_CUTOVER_EVIDENCE_PATH = resolve(artifactDirectory,"cutover-evidence.json");
        env.EOD_STORAGE_ANALYSIS_PATH = resolve(artifactDirectory,"storage-analysis.json");
        await phase("publication-growth");
        command("python",[resolve(root,"worker/scripts/measure-eod-publication-growth.py"),"--schema-sqlite",snapshot,
          "--samples-json",env.EOD_STORAGE_PUBLICATION_SAMPLES_PATH,"--output",env.EOD_STORAGE_PUBLICATION_GROWTH_PATH],env);
        const growth = read(env.EOD_STORAGE_PUBLICATION_GROWTH_PATH) as {afterBytes:number;beforeBytes:number;completeSessionSets:number;forecastSessions:number;revisionsPerSession:number};
        const reserve = Math.ceil((growth.afterBytes-growth.beforeBytes)/growth.completeSessionSets)*growth.forecastSessions*growth.revisionsPerSession;
        if (!Number.isSafeInteger(reserve) || reserve <= 0) throw new Error("storage-local-growth-measurement-invalid");
        await phase("final-capacity");
        command("python",[resolve(root,"worker/scripts/analyze-eod-storage.py"),"--source-sqlite",snapshot,"--tickers-json",tickerPath,
          "--session-date",plan.sessionDate,"--history-sqlite",historySnapshot,"--publication-growth-reserve-bytes",String(reserve),"--output",env.EOD_STORAGE_ANALYSIS_PATH!],env);
        await phase("runtime-candidate"); node("prepare-eod-runtime-candidate.ts",["run"]);
        await phase("cutover-evidence"); node("market-storage-runner.ts",["build-cutover-evidence"]);
      },
      accept: async () => { await phase("acceptance"); node("market-storage-runner.ts",["accept"]); },
      activate: async () => { await phase("activation"); node("activate-storage-migration-once.ts"); },
    });
    save(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "storage-local-failed";
    if (message === "storage-local-bootstrap-refresh-required"
      && ["publication-samples", "runtime-candidate", "cutover-evidence", "acceptance"].includes(stage)) {
      try {
        node("market-storage-runner.ts",["reconstruct"]);
        command("gh",["workflow","run","eod-storage-migration.yml","--repo","d0ofus/market-overview","--ref","main","-f",`migration_id=${migrationId}`]);
        save({status:"waiting",stage:"bootstrap",nextAttemptAt:new Date(Date.now()+30*60_000).toISOString(),reason:"latest-private-session-reconstruction-queued"});
      } catch (recoveryError) {
        save(localRecoveryFailure(recoveryError instanceof Error ? recoveryError.message : "storage-local-reconstruct-failed","bootstrap")); process.exitCode = 1;
      }
    } else { save(localRecoveryFailure(message,stage)); process.exitCode = 1; }
  } finally {
    await publish();
    try { await admission?.flush(); } finally { if (existsSync(lockPath)) unlinkSync(lockPath); }
  }
}
main().catch(() => { console.error(JSON.stringify({ status: "paused", reason: "storage-local-configuration-or-lock-invalid" })); process.exitCode = 1; });
