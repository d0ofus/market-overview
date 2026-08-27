import { getMarketDataDb } from "./market-data-db";
import { getOpsDb } from "./ops-db";
import type { Env } from "./types";

export type DatabaseCapacityLevel = "ok" | "warning" | "critical" | "halt" | "unavailable";

export type DatabaseCapacityStatus = {
  database: "core" | "market" | "ops";
  ok: boolean;
  sizeBytes: number | null;
  warnBytes: number;
  criticalBytes: number | null;
  haltBytes: number | null;
  level: DatabaseCapacityLevel;
  errorCode: string | null;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function thresholds(env: Env, database: DatabaseCapacityStatus["database"]): {
  warn: number;
  critical: number | null;
  halt: number | null;
} {
  if (database === "core") {
    return {
      warn: positiveInteger(env.CORE_DB_WARN_BYTES, 350_000_000),
      critical: positiveInteger(env.CORE_DB_CRITICAL_BYTES, 425_000_000),
      halt: positiveInteger(env.CORE_DB_HALT_BYTES, 450_000_000),
    };
  }
  if (database === "market") {
    return {
      warn: positiveInteger(env.MARKET_DATA_WARN_BYTES, 350_000_000),
      critical: positiveInteger(env.MARKET_DATA_CRITICAL_BYTES, 400_000_000),
      halt: positiveInteger(env.MARKET_DATA_HALT_BYTES, 425_000_000),
    };
  }
  return {
    warn: positiveInteger(env.OPS_DB_WARN_BYTES, 100_000_000),
    critical: null,
    halt: null,
  };
}

function capacityLevel(
  sizeBytes: number | null,
  limits: ReturnType<typeof thresholds>,
): DatabaseCapacityLevel {
  if (sizeBytes == null) return "ok";
  if (limits.halt != null && sizeBytes >= limits.halt) return "halt";
  if (limits.critical != null && sizeBytes >= limits.critical) return "critical";
  if (sizeBytes >= limits.warn) return "warning";
  return "ok";
}

async function probe(
  env: Env,
  database: DatabaseCapacityStatus["database"],
  db: D1Database,
): Promise<DatabaseCapacityStatus> {
  const limits = thresholds(env, database);
  try {
    const result = await db.prepare("SELECT 1 as ok").all<{ ok: number }>();
    const rawSize = Number(result.meta?.size_after);
    const sizeBytes = Number.isFinite(rawSize) ? rawSize : null;
    return {
      database,
      ok: true,
      sizeBytes,
      warnBytes: limits.warn,
      criticalBytes: limits.critical,
      haltBytes: limits.halt,
      level: capacityLevel(sizeBytes, limits),
      errorCode: null,
    };
  } catch (error) {
    return {
      database,
      ok: false,
      sizeBytes: null,
      warnBytes: limits.warn,
      criticalBytes: limits.critical,
      haltBytes: limits.halt,
      level: "unavailable",
      errorCode: error instanceof Error && "code" in error
        ? String(error.code)
        : "storage-unavailable",
    };
  }
}

export async function loadDatabaseCapacity(env: Env): Promise<DatabaseCapacityStatus[]> {
  let marketProbe: Promise<DatabaseCapacityStatus>;
  let opsProbe: Promise<DatabaseCapacityStatus>;
  try {
    marketProbe = probe(env, "market", getMarketDataDb(env));
  } catch (error) {
    const limits = thresholds(env, "market");
    marketProbe = Promise.resolve({
      database: "market",
      ok: false,
      sizeBytes: null,
      warnBytes: limits.warn,
      criticalBytes: limits.critical,
      haltBytes: limits.halt,
      level: "unavailable",
      errorCode: error instanceof Error && "code" in error ? String(error.code) : "market-data-db-unavailable",
    });
  }
  try {
    opsProbe = probe(env, "ops", getOpsDb(env));
  } catch (error) {
    const limits = thresholds(env, "ops");
    opsProbe = Promise.resolve({
      database: "ops",
      ok: false,
      sizeBytes: null,
      warnBytes: limits.warn,
      criticalBytes: limits.critical,
      haltBytes: limits.halt,
      level: "unavailable",
      errorCode: error instanceof Error && "code" in error ? String(error.code) : "ops-db-unavailable",
    });
  }
  return Promise.all([
    probe(env, "core", env.DB),
    marketProbe,
    opsProbe,
  ]);
}

export async function sampleDatabaseCapacity(env: Env, now = new Date()): Promise<DatabaseCapacityStatus[]> {
  const statuses = await loadDatabaseCapacity(env);
  const opsDb = getOpsDb(env);
  const statements = statuses.map((status) => opsDb.prepare(
    `INSERT INTO capacity_health_samples
       (id, database_key, observed_bytes, level, metadata_json, observed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    status.database,
    status.sizeBytes,
    status.level,
    JSON.stringify({
      ok: status.ok,
      warnBytes: status.warnBytes,
      criticalBytes: status.criticalBytes,
      haltBytes: status.haltBytes,
      errorCode: status.errorCode,
    }),
    now.toISOString(),
  ));
  if (statements.length > 0) await opsDb.batch(statements);
  for (const status of statuses) {
    if (status.level === "warning" || status.level === "critical" || status.level === "halt" || status.level === "unavailable") {
      console.warn("database capacity health alert", status);
    }
  }
  return statuses;
}
