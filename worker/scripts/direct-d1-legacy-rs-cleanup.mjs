#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(scriptDir, "..");

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "5ddf4343b603f05fed83f9e102b4b553";
const SOURCE_DB = { name: "market_command", id: "30528f34-b249-4d93-9b18-1d60a36df85d" };
const TARGET_DB = { name: "market_rs", id: "6837481f-3dd3-4f7c-933d-7927b5c755cd" };
const STATE_FILE = process.env.LEGACY_RS_DIRECT_STATE_FILE || path.join(workerRoot, "tmp", "direct-d1-legacy-rs-cleanup-state.json");

const TABLES = [
  {
    name: "rs_ratio_cache",
    keys: ["benchmark_ticker", "ticker", "trading_date"],
    orderBy: "benchmark_ticker ASC, ticker ASC, trading_date ASC",
    latestOrderBy: "trading_date DESC, benchmark_ticker ASC, ticker ASC",
    limit: Number(process.env.RS_RATIO_DIRECT_LIMIT || 1000),
    cols: [
      "benchmark_ticker",
      "ticker",
      "trading_date",
      "price_close",
      "benchmark_close",
      "rs_ratio_close",
      "created_at",
      "updated_at",
    ],
  },
  {
    name: "relative_strength_latest_cache",
    keys: ["config_key", "ticker"],
    orderBy: "config_key ASC, ticker ASC",
    latestOrderBy: "trading_date DESC, config_key ASC, ticker ASC",
    limit: Number(process.env.RS_LATEST_DIRECT_LIMIT || 500),
    cols: [
      "config_key",
      "ticker",
      "benchmark_ticker",
      "rs_ma_type",
      "rs_ma_length",
      "new_high_lookback",
      "trading_date",
      "price_close",
      "change_1d",
      "rs_ratio_close",
      "rs_ratio_ma",
      "rs_above_ma",
      "rs_new_high",
      "rs_new_high_before_price",
      "bull_cross",
      "approx_rs_rating",
      "created_at",
      "updated_at",
    ],
  },
  {
    name: "relative_strength_config_state",
    keys: ["config_key", "ticker"],
    orderBy: "config_key ASC, ticker ASC",
    latestOrderBy: "latest_trading_date DESC, config_key ASC, ticker ASC",
    limit: Number(process.env.RS_CONFIG_DIRECT_LIMIT || 100),
    cols: [
      "config_key",
      "ticker",
      "benchmark_ticker",
      "rs_ma_type",
      "rs_ma_length",
      "new_high_lookback",
      "state_version",
      "latest_trading_date",
      "updated_at",
      "price_close",
      "change_1d",
      "rs_ratio_close",
      "rs_ratio_ma",
      "rs_above_ma",
      "rs_new_high",
      "rs_new_high_before_price",
      "bull_cross",
      "approx_rs_rating",
      "price_close_history_json",
      "benchmark_close_history_json",
      "weighted_score_history_json",
      "rs_new_high_window_json",
      "price_new_high_window_json",
      "sma_window_json",
      "sma_sum",
      "ema_value",
      "previous_rs_close",
      "previous_rs_ma",
      "created_at",
    ],
  },
];

const SOURCE_CACHE_TABLES = [...TABLES.map((table) => table.name), "relative_strength_cache"];

const RUNTIME_COUNT_QUERIES = [
  ["relative_strength_refresh_queue", "SELECT COUNT(*) AS count FROM relative_strength_refresh_queue"],
  ["relative_strength_materialization_queue", "SELECT COUNT(*) AS count FROM relative_strength_materialization_queue"],
  ["relative_strength_materialization_run_deferred_tickers", "SELECT COUNT(*) AS count FROM relative_strength_materialization_run_deferred_tickers"],
  ["relative_strength_materialization_run_candidates", "SELECT COUNT(*) AS count FROM relative_strength_materialization_run_candidates"],
  ["relative_strength_materialization_runs", "SELECT COUNT(*) AS count FROM relative_strength_materialization_runs"],
  [
    "scan_refresh_job_top_rows:relative-strength",
    `SELECT COUNT(*) AS count
     FROM scan_refresh_job_top_rows
     WHERE job_id IN (SELECT id FROM scan_refresh_jobs WHERE job_type = 'relative-strength')`,
  ],
  [
    "scan_refresh_job_candidates:relative-strength",
    `SELECT COUNT(*) AS count
     FROM scan_refresh_job_candidates
     WHERE job_id IN (SELECT id FROM scan_refresh_jobs WHERE job_type = 'relative-strength')`,
  ],
  ["scan_refresh_jobs:relative-strength", "SELECT COUNT(*) AS count FROM scan_refresh_jobs WHERE job_type = 'relative-strength'"],
];

const RUNTIME_PURGE_SQL = [
  "DELETE FROM relative_strength_refresh_queue",
  "DELETE FROM relative_strength_materialization_queue",
  "DELETE FROM relative_strength_materialization_run_deferred_tickers",
  "DELETE FROM relative_strength_materialization_run_candidates",
  "DELETE FROM relative_strength_materialization_runs",
  `DELETE FROM scan_refresh_job_top_rows
   WHERE job_id IN (SELECT id FROM scan_refresh_jobs WHERE job_type = 'relative-strength')`,
  `DELETE FROM scan_refresh_job_candidates
   WHERE job_id IN (SELECT id FROM scan_refresh_jobs WHERE job_type = 'relative-strength')`,
  "DELETE FROM scan_refresh_jobs WHERE job_type = 'relative-strength'",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { tables: {} };
    throw error;
  }
}

async function writeState(state) {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function clearState() {
  await rm(STATE_FILE, { force: true });
}

function token() {
  const value = process.env.CLOUDFLARE_API_TOKEN;
  if (!value) throw new Error("Missing CLOUDFLARE_API_TOKEN.");
  return value;
}

async function d1Query(db, sql, params = [], attempt = 0) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${db.id}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });
  const body = await response.json().catch(() => ({}));
  const block = Array.isArray(body.result) ? body.result[0] : body.result;
  if (response.ok && body.success && block?.success !== false) {
    return block ?? { results: [], meta: {} };
  }

  const detail = JSON.stringify(body.errors?.length ? body.errors : body);
  if (attempt < 5 && (response.status === 429 || response.status >= 500 || /timed out|network|internal/i.test(detail))) {
    await sleep(1000 * 2 ** attempt);
    return d1Query(db, sql, params, attempt + 1);
  }
  throw new Error(`${db.name} D1 query failed (${response.status}): ${detail}\nSQL: ${sql.slice(0, 500)}`);
}

function countFrom(block) {
  return Math.max(0, Math.trunc(Number(block.results?.[0]?.count ?? 0)));
}

async function countTable(db, table) {
  return countFrom(await d1Query(db, `SELECT COUNT(*) AS count FROM ${table}`));
}

async function loadCounts() {
  const source = {};
  const target = {};
  const runtime = {};
  for (const table of SOURCE_CACHE_TABLES) {
    source[table] = await countTable(SOURCE_DB, table);
  }
  for (const table of TABLES) {
    target[table.name] = await countTable(TARGET_DB, table.name);
  }
  for (const [name, sql] of RUNTIME_COUNT_QUERIES) {
    runtime[name] = countFrom(await d1Query(SOURCE_DB, sql));
  }
  return { source, target, runtime };
}

function cursorWhere(table, cursor) {
  if (!cursor) return { sql: "", params: [] };
  if (table.keys.length === 3) {
    return {
      sql: `WHERE ${table.keys[0]} > ?
            OR (${table.keys[0]} = ? AND ${table.keys[1]} > ?)
            OR (${table.keys[0]} = ? AND ${table.keys[1]} = ? AND ${table.keys[2]} > ?)`,
      params: [cursor[0], cursor[0], cursor[1], cursor[0], cursor[1], cursor[2]],
    };
  }
  return {
    sql: `WHERE ${table.keys[0]} > ? OR (${table.keys[0]} = ? AND ${table.keys[1]} > ?)`,
    params: [cursor[0], cursor[0], cursor[1]],
  };
}

function keyFor(table, row) {
  return table.keys.map((key) => String(row[key] ?? ""));
}

async function loadSourceRows(table, cursor) {
  const where = cursorWhere(table, cursor);
  const sql = `SELECT ${table.cols.join(", ")} FROM ${table.name} ${where.sql} ORDER BY ${table.orderBy} LIMIT ?`;
  const block = await d1Query(SOURCE_DB, sql, [...where.params, Math.max(1, Math.trunc(table.limit))]);
  return block.results ?? [];
}

async function insertTargetRows(table, rows) {
  if (rows.length === 0) return 0;
  const cols = table.cols.join(", ");
  const extracts = table.cols.map((col) => `json_extract(value, '$.${col}')`).join(", ");
  const sql = `INSERT OR IGNORE INTO ${table.name} (${cols}) SELECT ${extracts} FROM json_each(?)`;
  const block = await d1Query(TARGET_DB, sql, [JSON.stringify(rows)]);
  return Math.max(0, Math.trunc(Number(block.meta?.changes ?? 0)));
}

async function backfillTable(table, state) {
  let tableState = state.tables[table.name] ?? {};
  if (tableState.done) {
    console.log(JSON.stringify({ event: "backfill-skip-done", table: table.name }));
    return;
  }
  let cursor = Array.isArray(tableState.cursor) ? tableState.cursor : null;
  let read = Math.max(0, Number(tableState.read ?? 0));
  let inserted = Math.max(0, Number(tableState.inserted ?? 0));

  while (true) {
    const rows = await loadSourceRows(table, cursor);
    if (rows.length === 0) {
      state.tables[table.name] = { ...tableState, cursor, read, inserted, done: true, updatedAt: new Date().toISOString() };
      await writeState(state);
      console.log(JSON.stringify({ event: "backfill-table-done", table: table.name, read, inserted }));
      return;
    }

    const insertedBatch = await insertTargetRows(table, rows);
    cursor = keyFor(table, rows[rows.length - 1]);
    read += rows.length;
    inserted += insertedBatch;
    tableState = { cursor, read, inserted, done: false, updatedAt: new Date().toISOString() };
    state.tables[table.name] = tableState;
    await writeState(state);
    console.log(JSON.stringify({ event: "backfill-batch", table: table.name, read, inserted, batchRows: rows.length, batchInserted: insertedBatch, cursor }));

    if (rows.length < table.limit) {
      state.tables[table.name] = { ...tableState, done: true, updatedAt: new Date().toISOString() };
      await writeState(state);
      console.log(JSON.stringify({ event: "backfill-table-done", table: table.name, read, inserted }));
      return;
    }
  }
}

function quoteSql(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

async function sourceSamples(table) {
  const samples = [];
  for (const orderBy of [table.orderBy, table.latestOrderBy]) {
    const block = await d1Query(SOURCE_DB, `SELECT ${table.keys.join(", ")} FROM ${table.name} ORDER BY ${orderBy} LIMIT 1`);
    if (block.results?.[0]) samples.push(block.results[0]);
  }
  const seen = new Set();
  return samples.filter((sample) => {
    const signature = keyFor(table, sample).join("\u0000");
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

async function verifySamples() {
  const checked = [];
  for (const table of TABLES) {
    for (const sample of await sourceSamples(table)) {
      const where = table.keys.map((key) => `${key} = ${quoteSql(sample[key])}`).join(" AND ");
      const count = countFrom(await d1Query(TARGET_DB, `SELECT COUNT(*) AS count FROM ${table.name} WHERE ${where}`));
      checked.push({ table: table.name, sample, present: count > 0 });
      if (count === 0) throw new Error(`Sample key missing from ${TARGET_DB.name}.${table.name}: ${JSON.stringify(sample)}`);
    }
  }
  console.log(JSON.stringify({ event: "sample-verification", checked }, null, 2));
}

function verifyCoverage(before, after) {
  for (const table of TABLES) {
    const source = after.source[table.name] ?? 0;
    const target = after.target[table.name] ?? 0;
    if (table.name === "rs_ratio_cache" && (before.target[table.name] ?? 0) === 0) {
      if (target !== source) throw new Error(`${table.name} count mismatch: source=${source} target=${target}`);
    } else if (target < source) {
      throw new Error(`${table.name} coverage shortfall: source=${source} target=${target}`);
    }
  }
}

function deleteByKeysSql(table) {
  const tuple = `(${table.keys.join(", ")})`;
  const extractedCols = table.keys.map((key) => `json_extract(value, '$.${key}')`).join(", ");
  return `DELETE FROM ${table.name} WHERE ${tuple} IN (SELECT ${extractedCols} FROM json_each(?))`;
}

async function purgeTableByKeys(table) {
  let deleted = 0;
  while (true) {
    const block = await d1Query(SOURCE_DB, `SELECT ${table.keys.join(", ")} FROM ${table.name} ORDER BY ${table.orderBy} LIMIT ?`, [Math.max(1, Math.trunc(table.limit))]);
    const keys = block.results ?? [];
    if (keys.length === 0) {
      console.log(JSON.stringify({ event: "purge-table-done", table: table.name, deleted }));
      return deleted;
    }
    const result = await d1Query(SOURCE_DB, deleteByKeysSql(table), [JSON.stringify(keys)]);
    const changed = Math.max(0, Math.trunc(Number(result.meta?.changes ?? 0)));
    deleted += changed;
    console.log(JSON.stringify({ event: "purge-batch", table: table.name, selected: keys.length, deleted, batchDeleted: changed }));
    if (changed === 0) {
      throw new Error(`Purge stalled for ${table.name}; selected ${keys.length} keys but deleted 0 rows.`);
    }
  }
}

async function purgeRuntimeRows() {
  for (const sql of RUNTIME_PURGE_SQL) {
    const result = await d1Query(SOURCE_DB, sql);
    console.log(JSON.stringify({ event: "purge-runtime", sql: sql.replace(/\s+/g, " ").trim(), changes: result.meta?.changes ?? 0 }));
  }
}

async function purgeRelativeStrengthCache() {
  const result = await d1Query(SOURCE_DB, "DELETE FROM relative_strength_cache");
  console.log(JSON.stringify({ event: "purge-cache", table: "relative_strength_cache", changes: result.meta?.changes ?? 0 }));
}

function verifyPurged(after, targetBeforePurge) {
  for (const table of SOURCE_CACHE_TABLES) {
    if ((after.source[table] ?? 0) !== 0) throw new Error(`${SOURCE_DB.name}.${table} still has ${after.source[table]} rows.`);
  }
  for (const [name, count] of Object.entries(after.runtime)) {
    if (count !== 0) throw new Error(`${SOURCE_DB.name} runtime rows remain for ${name}: ${count}`);
  }
  for (const table of TABLES) {
    if ((after.target[table.name] ?? 0) < (targetBeforePurge[table.name] ?? 0)) {
      throw new Error(`${TARGET_DB.name}.${table.name} count decreased during purge.`);
    }
  }
}

async function main() {
  if (!process.argv.includes("--purge") || !process.argv.includes("--confirm") || process.argv[process.argv.indexOf("--confirm") + 1] !== SOURCE_DB.name) {
    throw new Error(`Refusing to run production cleanup without --purge --confirm ${SOURCE_DB.name}`);
  }

  const before = await loadCounts();
  console.log(JSON.stringify({ event: "counts-before", ...before }, null, 2));

  const state = await readState();
  for (const table of TABLES) {
    await backfillTable(table, state);
  }

  const afterBackfill = await loadCounts();
  console.log(JSON.stringify({ event: "counts-after-backfill", ...afterBackfill }, null, 2));
  verifyCoverage(before, afterBackfill);
  await verifySamples();

  await purgeRuntimeRows();
  await purgeRelativeStrengthCache();
  for (const table of TABLES) {
    await purgeTableByKeys(table);
  }

  const afterPurge = await loadCounts();
  console.log(JSON.stringify({ event: "counts-after-purge", ...afterPurge }, null, 2));
  verifyPurged(afterPurge, afterBackfill.target);
  await clearState();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
