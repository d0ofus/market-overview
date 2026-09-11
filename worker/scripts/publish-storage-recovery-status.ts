import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { fetchEodAccountUsage, reconcileEodAccountUsage } from "../src/eod-account-usage";
import { storeEodControllerReport } from "../src/eod-recovery-status";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), tmp = resolve(root, "worker/tmp");
async function main() {
  const file = resolve(process.argv[2] ?? resolve(tmp, "storage-recovery-config.json")), local = relative(tmp, file);
  if (!local || local.startsWith("..") || isAbsolute(local)) throw new Error("eod-recovery-report-path-invalid");
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as unknown;
  const config = z.object({ accountId: z.string().regex(/^[a-f0-9]{32}$/), opsDatabaseId: z.string().uuid(),
    codeRevision: z.string().regex(/^[a-f0-9]{40}$/) }).parse(read(file));
  const state = z.object({ status: z.enum(["running", "waiting", "paused", "completed"]), stage: z.string(), reason: z.string(),
    nextAttemptAt: z.string().nullable(), updatedAt: z.string(), codeRevision: z.string() }).parse(read(resolve(tmp, "storage-recovery-status.json")));
  if (state.codeRevision !== config.codeRevision) throw new Error("eod-recovery-report-checkout-mismatch");
  const token = process.env.CLOUDFLARE_EOD_D1_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("eod-recovery-report-credential-unavailable");
  const analyticsToken = process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token;
  const usage = await fetchEodAccountUsage({ accountId: config.accountId, token: analyticsToken, usageDate: new Date().toISOString().slice(0, 10) });
  if (usage.rowsRead >= resolveEodBudgetProfile(process.env.EOD_BUDGET_PROFILE).accountDaily.reads || usage.rowsWritten >= resolveEodBudgetProfile(process.env.EOD_BUDGET_PROFILE).accountDaily.writes) throw new Error("eod-recovery-report-quota-deferred");
  const options = { accountId: config.accountId, token, databaseId: config.opsDatabaseId, allowedDatabaseIds: [config.opsDatabaseId] };
  const rawOps = createEodD1Database(options);
  const admission = createEodAdmission(rawOps, "eod-recovery-status", { profile: resolveEodBudgetProfile(process.env.EOD_BUDGET_PROFILE), readCredit: 100, writeCredit: 20,
    reconcileAccountUsage: () => reconcileEodAccountUsage({profile:resolveEodBudgetProfile(process.env.EOD_BUDGET_PROFILE), accountId: config.accountId, token: analyticsToken, ops: rawOps }) });
  try { await storeEodControllerReport(createEodD1Database({ ...options, admission }), { version: 1, ...state }); }
  finally { await admission.flush(); }
  console.log(JSON.stringify({ status: "recovery-status-published", observedAt: state.updatedAt }));
}
main().catch(() => { console.error("Recovery status sync unavailable; local state retained."); process.exitCode = 1; });
