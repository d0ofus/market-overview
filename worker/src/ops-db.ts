import type { Env } from "./types";

export type MarketPipelineMode = "paused" | "canary" | "active";

function enabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

export class OpsDbUnavailableError extends Error {
  readonly code = "ops-db-unavailable";

  constructor(message = "OPS_DB is required but is not bound or its schema is unavailable.") {
    super(message);
    this.name = "OpsDbUnavailableError";
  }
}

export class MarketPipelinePausedError extends Error {
  readonly code = "market-pipeline-paused";

  constructor(readonly mode: MarketPipelineMode) {
    super(`Market-data pipeline is ${mode}; provider mutations are disabled.`);
    this.name = "MarketPipelinePausedError";
  }
}

export function isOpsDbRequired(env: Env): boolean {
  return enabled(env.OPS_DB_REQUIRED);
}

export function getOpsDb(env: Env): D1Database {
  if (env.OPS_DB && typeof env.OPS_DB.prepare === "function") return env.OPS_DB;
  if (isOpsDbRequired(env)) throw new OpsDbUnavailableError();
  return env.DB;
}

export function marketPipelineMode(env: Env): MarketPipelineMode {
  const normalized = String(env.MARKET_PIPELINE_MODE ?? "active").trim().toLowerCase();
  if (normalized === "paused" || normalized === "canary") return normalized;
  return "active";
}

export function assertMarketPipelineActive(env: Env, allowCanary = false): void {
  const mode = marketPipelineMode(env);
  if (mode === "active" || (allowCanary && mode === "canary")) return;
  throw new MarketPipelinePausedError(mode);
}

export function isOpsSchemaUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /no such table|no such column|OPS_DB|\.prepare is not a function|\.run is not a function|\.first is not a function/i.test(message);
}
