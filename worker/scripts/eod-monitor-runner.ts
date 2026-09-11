import { resolveEodRunnerCodeRevision } from "../src/eod-runner-revision";
import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { execFileSync } from "node:child_process";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { collectEodRolloutMonitoring, finalizeRecentEodUsage } from "../src/eod-rollout-monitor";
import { refreshApprovedStorageHistoryCapacity } from "../src/eod-storage-history-capacity";
import type { Env } from "../src/types";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`eod-monitor-missing-setting:${name}`);
  return value;
}

async function main(): Promise<void> {
  const actualRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
  const codeRevision = resolveEodRunnerCodeRevision({ actualRevision, productionRevision: process.env.EOD_PRODUCTION_CODE_REVISION,
    codeRevision: process.env.EOD_CODE_REVISION, githubSha: process.env.GITHUB_SHA });
  const accountId = required("CLOUDFLARE_ACCOUNT_ID"), token = required("CLOUDFLARE_EOD_D1_TOKEN");
  const market = required("EOD_MARKET_DATABASE_ID"), ops = required("EOD_OPS_DATABASE_ID");
  const history = required("EOD_HISTORY_DATABASE_ID");
  const analyticsToken = process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token;
  const allowedDatabaseIds = [market, ops, history];
  if (new Set(allowedDatabaseIds).size !== allowedDatabaseIds.length) throw new Error("eod-monitor-database-identity-conflict");
  const rawOps = createEodD1Database({ accountId, token, databaseId: ops, allowedDatabaseIds });
  const admission = createEodAdmission(rawOps, `eod-monitor:${new Date().toISOString().slice(0, 10)}`, { profile: resolveEodBudgetProfile(process.env.EOD_BUDGET_PROFILE),
    reconcileAccountUsage: () => reconcileEodAccountUsage({profile:resolveEodBudgetProfile(process.env.EOD_BUDGET_PROFILE), accountId, token: analyticsToken, ops: rawOps }),
  });
  const database = (databaseId: string) => createEodD1Database({ accountId, token, databaseId, allowedDatabaseIds, admission });
  const env = {
    EOD_BUDGET_PROFILE: process.env.EOD_BUDGET_PROFILE,
    DB: database(market), MARKET_DATA_DB: database(market), OPS_DB: database(ops), MARKET_HISTORY_DB: database(history),
    EOD_CODE_REVISION: codeRevision,
    MARKET_DATA_DB_REQUIRED: "true", OPS_DB_REQUIRED: "true",
    EOD_RUNNER_MODE: process.env.EOD_RUNNER_MODE === "active" ? "active" : "shadow",
    EOD_READ_ENABLED: process.env.EOD_RUNNER_MODE === "active" ? "true" : "false",
  } as Env;
  try {
    // A real admitted control query establishes today's EOD ledger even on a
    // holiday/weekend with no ingestion. Zero never comes from an absent row.
    await env.OPS_DB!.prepare("SELECT 1 AS monitoring_probe").first();
    const usage = await finalizeRecentEodUsage({ accountId, token: analyticsToken, ops: env.OPS_DB! });
    const monitoring = await collectEodRolloutMonitoring(env);
    console.log(JSON.stringify({ status: "monitored", usage,
      latestEvaluatedSession: monitoring.latestEvaluatedSession,
      consecutivePassedSessions: monitoring.consecutivePassedSessions,
      eligibleForRetirement: monitoring.eligibleForRetirement, reasons: monitoring.reasons }));
    // A separate daily capacity pass is independent of archive pruning. It
    // samples the accepted layout only after public activation and never moves
    // the forecast horizon simply because another day elapsed.
    if (env.EOD_RUNNER_MODE === "active") await refreshApprovedStorageHistoryCapacity(env);
  } finally {
    await admission.flush();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  // No provider response bodies, SQL, credentials or database identifiers in
  // public Actions logs. Quota failure waits for the next daily invocation.
  const reason = /^eod-(?:monitor|account-usage|d1)-[a-z-]+(?::[A-Z_]+)?$/.test(message)
    ? message : /quota|budget|capacity/i.test(message) ? "eod-monitor-resource-budget" : "eod-monitor-unavailable";
  console.error(JSON.stringify({ status: "deferred", reason }));
  process.exitCode = 1;
});
