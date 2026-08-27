import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const SOURCE_DB = "market_command";
const MARKET_DB = "market_prices";
const TARGET_DB = "market_ops";
const CONFIRMATION = "SEED MARKET OPS COUNTERS";
const require = createRequire(import.meta.url);
const wranglerCliPath = require.resolve("wrangler/bin/wrangler.js");

function run(args) {
  const result = spawnSync(process.execPath, [wranglerCliPath, ...args], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `wrangler ${args.join(" ")} failed`);
  return result.stdout;
}

function query(database, sql) {
  const parsed = JSON.parse(run(["d1", "execute", database, "--remote", "--json", "--command", sql]));
  const block = Array.isArray(parsed) ? parsed[0] : parsed;
  return block?.results ?? block?.result?.[0]?.results ?? [];
}

function sqlValue(value) {
  if (value == null) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

const confirmIndex = process.argv.indexOf("--confirm");
if (confirmIndex < 0 || process.argv[confirmIndex + 1] !== CONFIRMATION) {
  throw new Error(`Refusing OPS seed. Pass --confirm "${CONFIRMATION}".`);
}

const now = new Date();
const usageDay = now.toISOString().slice(0, 10);
const minuteBucket = now.toISOString().slice(0, 16);
const minuteRows = query(
  SOURCE_DB,
  `SELECT provider_key as providerKey, request_count as requestCount
     FROM provider_usage_minute WHERE minute_bucket = '${minuteBucket}'`,
);
const dailyRows = query(
  SOURCE_DB,
  `SELECT * FROM provider_usage_daily WHERE usage_day = '${usageDay}'`,
);
const marketUsageRows = query(
  MARKET_DB,
  `SELECT usage_date, bars_written, rows_read, rows_written, updated_at
     FROM market_data_daily_usage WHERE usage_date = '${usageDay}'`,
);
const statements = [];
for (const row of minuteRows) {
  statements.push(`INSERT INTO provider_budget_counters (provider_key, window_kind, window_bucket, request_count, updated_at)
    VALUES (${sqlValue(row.providerKey)}, 'minute', ${sqlValue(minuteBucket)}, ${sqlValue(Number(row.requestCount ?? 0))}, CURRENT_TIMESTAMP)
    ON CONFLICT(provider_key, window_kind, window_bucket) DO UPDATE SET request_count = MAX(request_count, excluded.request_count), updated_at = CURRENT_TIMESTAMP`);
}
const dayCounts = new Map();
for (const row of dailyRows) {
  const providerKey = String(row.provider_key ?? row.providerKey ?? "");
  if (!providerKey) continue;
  dayCounts.set(providerKey, (dayCounts.get(providerKey) ?? 0) + Number(row.request_count ?? row.requestCount ?? 0));
  const columns = [
    "usage_day", "provider_key", "endpoint_key", "caller", "request_count", "success_count",
    "error_count", "rate_limited_count", "timeout_count", "symbol_count", "row_count",
    "cache_hit_count", "total_duration_ms", "last_status", "last_error", "last_called_at", "updated_at",
  ];
  const values = columns.map((column) => sqlValue(row[column] ?? (column === "updated_at" ? now.toISOString() : null)));
  statements.push(`INSERT INTO provider_usage_daily (${columns.join(",")}) VALUES (${values.join(",")})
    ON CONFLICT(usage_day, provider_key, endpoint_key, caller) DO UPDATE SET
      request_count = MAX(request_count, excluded.request_count),
      success_count = MAX(success_count, excluded.success_count),
      error_count = MAX(error_count, excluded.error_count),
      updated_at = CURRENT_TIMESTAMP`);
}
for (const [providerKey, count] of dayCounts) {
  statements.push(`INSERT INTO provider_budget_counters (provider_key, window_kind, window_bucket, request_count, updated_at)
    VALUES (${sqlValue(providerKey)}, 'day', ${sqlValue(usageDay)}, ${sqlValue(count)}, CURRENT_TIMESTAMP)
    ON CONFLICT(provider_key, window_kind, window_bucket) DO UPDATE SET request_count = MAX(request_count, excluded.request_count), updated_at = CURRENT_TIMESTAMP`);
}
for (const row of marketUsageRows) {
  statements.push(`INSERT INTO market_data_daily_usage (usage_date, bars_written, rows_read, rows_written, updated_at)
    VALUES (${sqlValue(row.usage_date)}, ${sqlValue(Number(row.bars_written ?? 0))},
            ${sqlValue(Number(row.rows_read ?? 0))}, ${sqlValue(Number(row.rows_written ?? 0))},
            ${sqlValue(row.updated_at ?? now.toISOString())})
    ON CONFLICT(usage_date) DO UPDATE SET
      bars_written = MAX(bars_written, excluded.bars_written),
      rows_read = MAX(rows_read, excluded.rows_read),
      rows_written = MAX(rows_written, excluded.rows_written),
      updated_at = CURRENT_TIMESTAMP`);
}
if (statements.length > 0) {
  run(["d1", "execute", TARGET_DB, "--remote", "--yes", "--command", `${statements.join(";\n")};`]);
}
const seeded = query(TARGET_DB, `SELECT provider_key, window_kind, window_bucket, request_count FROM provider_budget_counters WHERE window_bucket IN ('${usageDay}', '${minuteBucket}') ORDER BY provider_key, window_kind`);
const seededMarketUsage = query(TARGET_DB, `SELECT * FROM market_data_daily_usage WHERE usage_date = '${usageDay}'`);
process.stdout.write(`${JSON.stringify({ ok: true, usageDay, minuteBucket, seeded, seededMarketUsage }, null, 2)}\n`);
