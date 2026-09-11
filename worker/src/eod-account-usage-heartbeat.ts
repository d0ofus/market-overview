import { reconcileEodAccountUsage } from "./eod-account-usage";
import { loadEodRollingUsage, resolveEodBudgetProfile } from "./eod-budget-profile";
import type { Env } from "./types";

/** Independent of market sessions, ingestion ownership and the canary gate.
 * The native Ops binding needs no D1 REST credentials. Reconciliation charges
 * its bounded control writes, while every application write retains admission. */
export async function refreshEodAccountUsageHeartbeat(env: Env, now = new Date(), fetcher: typeof fetch = fetch) {
  const profile = resolveEodBudgetProfile(env.EOD_BUDGET_PROFILE);
  if (!profile.rolling31 || env.EOD_RUNTIME_CANDIDATE_ONLY === "true") return { status: "disabled" as const };
  if (!env.OPS_DB || !env.EOD_ANALYTICS_TOKEN || !/^[a-f0-9]{32}$/i.test(env.EOD_CLOUDFLARE_ACCOUNT_ID ?? "")) {
    return { status: "unavailable" as const, reason: "eod-account-heartbeat-settings-missing" };
  }
  try {
    const cached = await loadEodRollingUsage(env.OPS_DB, profile, now);
    if (cached && now.getTime() - Date.parse(cached.sampledAt) < 240_000) return { status: "fresh" as const };
  } catch { /* A missing/stale window needs a real collection. */ }
  const token = crypto.randomUUID(), id = "eod-account-usage:heartbeat", stamp = now.toISOString();
  const payload = (status: string) => JSON.stringify({ version: 1, token, status, checkedAt: stamp });
  const claim = await env.OPS_DB.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json,updated_at=excluded.updated_at
    WHERE eod_rollout_evidence.updated_at<=? RETURNING id`)
    .bind(id, payload("running"), stamp, new Date(now.getTime() - 240_000).toISOString()).all<{ id: string }>();
  if (claim.results.length !== 1) return { status: "cooldown" as const };
  let status: "refreshed" | "unavailable" = "refreshed";
  try {
    await reconcileEodAccountUsage({ accountId: env.EOD_CLOUDFLARE_ACCOUNT_ID!, token: env.EOD_ANALYTICS_TOKEN,
      ops: env.OPS_DB, profile, now, fetcher });
  } catch { status = "unavailable"; }
  await env.OPS_DB.prepare(`UPDATE eod_rollout_evidence SET evidence_json=? WHERE id=? AND json_extract(evidence_json,'$.token')=?`)
    .bind(payload(status), id, token).run();
  return { status, ...(status === "unavailable" ? { reason: "eod-account-window-unavailable" } : {}) };
}
