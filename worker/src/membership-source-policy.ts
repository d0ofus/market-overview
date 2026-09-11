import { ProviderBudgetExceededError, ProviderBudgetUnavailableError, ProviderRequestFailureError } from "./provider-usage";

/** Exhausted provider requests are a source outage; an unavailable admission
 * ledger is infrastructure failure and must stop the resumable batch. */
export function isMembershipInfrastructureFailure(error: unknown): boolean {
  if (error instanceof ProviderBudgetExceededError || error instanceof ProviderRequestFailureError) return false;
  if (error instanceof ProviderBudgetUnavailableError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\bD1\b|\bD1_|\bd1-|\beod-|\bSQLITE|database|no such (?:table|column)|quota|budget|capacity|universe-(?:storage|stage|promotion)-)/i.test(message);
}

export function membershipRetryNotBefore(error: unknown, now = new Date()): string | undefined {
  if (!(error instanceof ProviderBudgetExceededError) || error.window !== "day") return undefined;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5)).toISOString();
}
