#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(scriptDir, "..");

export const SOURCE_DB = "market_command";
export const TARGET_DB = "market_rs";
export const DEFAULT_BACKFILL_LIMIT = 1000;
export const DEFAULT_STATE_FILE = path.join(workerRoot, "tmp", "legacy-rs-cache-cleanup-state.json");

export const MIGRATED_CACHE_TABLES = [
  "rs_ratio_cache",
  "relative_strength_latest_cache",
  "relative_strength_config_state",
];

export const SOURCE_CACHE_TABLES = [
  ...MIGRATED_CACHE_TABLES,
  "relative_strength_cache",
];

export const RUNTIME_COUNT_QUERIES = [
  {
    name: "relative_strength_refresh_queue",
    sql: "SELECT COUNT(*) AS rowCount FROM relative_strength_refresh_queue",
  },
  {
    name: "relative_strength_materialization_queue",
    sql: "SELECT COUNT(*) AS rowCount FROM relative_strength_materialization_queue",
  },
  {
    name: "relative_strength_materialization_run_deferred_tickers",
    sql: "SELECT COUNT(*) AS rowCount FROM relative_strength_materialization_run_deferred_tickers",
  },
  {
    name: "relative_strength_materialization_run_candidates",
    sql: "SELECT COUNT(*) AS rowCount FROM relative_strength_materialization_run_candidates",
  },
  {
    name: "relative_strength_materialization_runs",
    sql: "SELECT COUNT(*) AS rowCount FROM relative_strength_materialization_runs",
  },
  {
    name: "scan_refresh_job_top_rows:relative-strength",
    sql: `SELECT COUNT(*) AS rowCount
          FROM scan_refresh_job_top_rows
          WHERE job_id IN (
            SELECT id FROM scan_refresh_jobs WHERE job_type = 'relative-strength'
          )`,
  },
  {
    name: "scan_refresh_job_candidates:relative-strength",
    sql: `SELECT COUNT(*) AS rowCount
          FROM scan_refresh_job_candidates
          WHERE job_id IN (
            SELECT id FROM scan_refresh_jobs WHERE job_type = 'relative-strength'
          )`,
  },
  {
    name: "scan_refresh_jobs:relative-strength",
    sql: "SELECT COUNT(*) AS rowCount FROM scan_refresh_jobs WHERE job_type = 'relative-strength'",
  },
];

const SAMPLE_DEFS = {
  rs_ratio_cache: {
    keys: ["benchmark_ticker", "ticker", "trading_date"],
    firstOrder: "benchmark_ticker ASC, ticker ASC, trading_date ASC",
    latestOrder: "trading_date DESC, benchmark_ticker ASC, ticker ASC",
  },
  relative_strength_latest_cache: {
    keys: ["config_key", "ticker"],
    firstOrder: "config_key ASC, ticker ASC",
    latestOrder: "trading_date DESC, config_key ASC, ticker ASC",
  },
  relative_strength_config_state: {
    keys: ["config_key", "ticker"],
    firstOrder: "config_key ASC, ticker ASC",
    latestOrder: "latest_trading_date DESC, config_key ASC, ticker ASC",
  },
};

const PURGE_STATEMENTS = [
  "DELETE FROM relative_strength_refresh_queue",
  "DELETE FROM relative_strength_materialization_queue",
  "DELETE FROM relative_strength_materialization_run_deferred_tickers",
  "DELETE FROM relative_strength_materialization_run_candidates",
  "DELETE FROM relative_strength_materialization_runs",
  `DELETE FROM scan_refresh_job_top_rows
   WHERE job_id IN (
     SELECT id FROM scan_refresh_jobs WHERE job_type = 'relative-strength'
   )`,
  `DELETE FROM scan_refresh_job_candidates
   WHERE job_id IN (
     SELECT id FROM scan_refresh_jobs WHERE job_type = 'relative-strength'
   )`,
  "DELETE FROM scan_refresh_jobs WHERE job_type = 'relative-strength'",
  "DELETE FROM relative_strength_cache",
  "DELETE FROM rs_ratio_cache",
  "DELETE FROM relative_strength_latest_cache",
  "DELETE FROM relative_strength_config_state",
];

function normalizeBaseUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function parseLimit(value) {
  const parsed = Math.trunc(Number(value ?? DEFAULT_BACKFILL_LIMIT));
  if (!Number.isFinite(parsed)) return DEFAULT_BACKFILL_LIMIT;
  return Math.min(DEFAULT_BACKFILL_LIMIT, Math.max(1, parsed));
}

function readFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

export function parseCliArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    backfill: false,
    purge: false,
    confirm: null,
    limit: parseLimit(env.BACKFILL_LIMIT),
    stateFile: env.LEGACY_RS_CACHE_STATE_FILE || DEFAULT_STATE_FILE,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--backfill") {
      options.backfill = true;
    } else if (arg === "--purge") {
      options.purge = true;
    } else if (arg === "--confirm") {
      options.confirm = readFlagValue(argv, index, arg);
      index += 1;
    } else if (arg === "--limit") {
      options.limit = parseLimit(readFlagValue(argv, index, arg));
      index += 1;
    } else if (arg === "--state-file") {
      options.stateFile = path.resolve(readFlagValue(argv, index, arg));
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.purge) {
    options.backfill = true;
    if (options.confirm !== SOURCE_DB) {
      throw new Error(`Refusing purge. Re-run with --purge --confirm ${SOURCE_DB}.`);
    }
  }

  return options;
}

export function getPurgeStatements() {
  return [...PURGE_STATEMENTS];
}

function usage() {
  return [
    "Usage:",
    "  npm run legacy-rs-cache:cleanup -w worker",
    "  npm run legacy-rs-cache:cleanup -w worker -- --backfill",
    `  npm run legacy-rs-cache:cleanup -w worker -- --purge --confirm ${SOURCE_DB}`,
    "",
    "Required environment:",
    "  WORKER_BASE_URL=https://your-worker.example.com",
    "  ADMIN_SECRET=...",
    "",
    "Optional environment:",
    "  BACKFILL_LIMIT=1000",
    "  LEGACY_RS_CACHE_STATE_FILE=worker/tmp/legacy-rs-cache-cleanup-state.json",
    "  WRANGLER_BIN=wrangler",
  ].join("\n");
}

async function defaultCommandRunner(command, args, options) {
  return execFile(command, args, {
    cwd: options?.cwd ?? workerRoot,
    maxBuffer: 20 * 1024 * 1024,
    shell: process.platform === "win32" && !path.extname(command),
  });
}

function parseWranglerD1Rows(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return [];
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse Wrangler JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }

  const blocks = Array.isArray(payload) ? payload : [payload];
  for (const block of blocks) {
    if (Array.isArray(block?.results)) return block.results;
    if (Array.isArray(block?.result?.results)) return block.result.results;
    if (Array.isArray(block?.result?.[0]?.results)) return block.result[0].results;
  }
  return [];
}

async function executeD1(database, sql, deps) {
  const command = deps.wranglerBin || "wrangler";
  const args = ["d1", "execute", database, "--remote", "--json", "--command", sql];
  const { stdout } = await deps.commandRunner(command, args, { cwd: workerRoot });
  return parseWranglerD1Rows(stdout);
}

function rowCount(rows) {
  const first = rows[0] ?? {};
  return Math.max(0, Math.trunc(Number(first.rowCount ?? first.count ?? 0)));
}

async function countTable(database, table, deps) {
  return rowCount(await executeD1(database, `SELECT COUNT(*) AS rowCount FROM ${table}`, deps));
}

export async function loadDirectCounts(deps) {
  const source = {};
  const target = {};
  const runtime = {};

  for (const table of SOURCE_CACHE_TABLES) {
    source[table] = await countTable(SOURCE_DB, table, deps);
  }
  for (const table of MIGRATED_CACHE_TABLES) {
    target[table] = await countTable(TARGET_DB, table, deps);
  }
  for (const query of RUNTIME_COUNT_QUERIES) {
    runtime[query.name] = rowCount(await executeD1(SOURCE_DB, query.sql, deps));
  }

  return { source, target, runtime };
}

async function fetchJson(url, init, fetchImpl) {
  const response = await fetchImpl(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${body.error ?? JSON.stringify(body)}`);
  }
  return body;
}

export async function fetchStatus({ workerBaseUrl, adminSecret, fetchImpl = fetch }) {
  return fetchJson(`${normalizeBaseUrl(workerBaseUrl)}/api/admin/scanner-cache/rs-cache-status`, {
    headers: {
      Authorization: `Bearer ${adminSecret}`,
      Accept: "application/json",
    },
  }, fetchImpl);
}

async function readState(stateFile) {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(stateFile, state) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function clearState(stateFile) {
  await rm(stateFile, { force: true });
}

export async function runBackfill({
  workerBaseUrl,
  adminSecret,
  limit = DEFAULT_BACKFILL_LIMIT,
  stateFile = DEFAULT_STATE_FILE,
  fetchImpl = fetch,
  logger = console,
}) {
  const state = await readState(stateFile);
  let cursor = typeof state?.cursor === "string" && state.cursor.length > 0 ? state.cursor : null;
  let totalCopied = 0;
  let batches = 0;

  if (cursor) {
    logger.log(JSON.stringify({ event: "backfill-resume", cursor }));
  }

  while (true) {
    const payload = { table: "all", limit };
    if (cursor) payload.cursor = cursor;

    const result = await fetchJson(`${normalizeBaseUrl(workerBaseUrl)}/api/admin/scanner-cache/rs-cache-backfill`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminSecret}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    }, fetchImpl);

    batches += 1;
    totalCopied += Math.max(0, Math.trunc(Number(result.copied ?? 0)));
    cursor = result.nextCursor ?? result.cursor ?? null;

    logger.log(JSON.stringify({
      event: "backfill-batch",
      batch: batches,
      copied: result.copied ?? 0,
      done: Boolean(result.done),
      tables: result.tables ?? [],
    }));

    if (result.done) {
      await clearState(stateFile);
      return { batches, copied: totalCopied, done: true };
    }

    if (!cursor) {
      throw new Error("Backfill did not finish and did not return nextCursor.");
    }

    await writeState(stateFile, {
      cursor,
      copied: totalCopied,
      batches,
      updatedAt: new Date().toISOString(),
    });
  }
}

function sqlLiteral(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function sampleSignature(keys, row) {
  return keys.map((key) => String(row[key] ?? "")).join("\u0000");
}

async function loadSourceSamples(table, deps) {
  const def = SAMPLE_DEFS[table];
  const samples = [];
  for (const orderBy of [def.firstOrder, def.latestOrder]) {
    const rows = await executeD1(SOURCE_DB, `SELECT ${def.keys.join(", ")} FROM ${table} ORDER BY ${orderBy} LIMIT 1`, deps);
    if (rows[0]) samples.push(rows[0]);
  }
  const seen = new Set();
  return samples.filter((row) => {
    const signature = sampleSignature(def.keys, row);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

async function verifyTargetSample(table, sample, deps) {
  const def = SAMPLE_DEFS[table];
  const where = def.keys.map((key) => `${key} = ${sqlLiteral(sample[key])}`).join(" AND ");
  const rows = await executeD1(TARGET_DB, `SELECT COUNT(*) AS rowCount FROM ${table} WHERE ${where}`, deps);
  return rowCount(rows) > 0;
}

export async function verifySampleKeys(deps) {
  const checked = [];
  for (const table of MIGRATED_CACHE_TABLES) {
    const samples = await loadSourceSamples(table, deps);
    for (const sample of samples) {
      const present = await verifyTargetSample(table, sample, deps);
      checked.push({ table, sample, present });
      if (!present) {
        throw new Error(`Backfill sample check failed for ${table}: ${JSON.stringify(sample)}`);
      }
    }
  }
  return checked;
}

export function verifyBackfillCoverage(beforeCounts, afterCounts) {
  for (const table of MIGRATED_CACHE_TABLES) {
    const sourceCount = afterCounts.source[table] ?? 0;
    const targetCount = afterCounts.target[table] ?? 0;
    const targetBefore = beforeCounts.target[table] ?? 0;

    if (table === "rs_ratio_cache" && targetBefore === 0) {
      if (targetCount !== sourceCount) {
        throw new Error(`${table} backfill verification failed: expected exact target count ${sourceCount}, got ${targetCount}.`);
      }
      continue;
    }

    if (targetCount < sourceCount) {
      throw new Error(`${table} backfill verification failed: target count ${targetCount} is below source count ${sourceCount}.`);
    }
  }
}

export async function runPurge({ commandRunner = defaultCommandRunner, wranglerBin, logger = console } = {}) {
  const deps = { commandRunner, wranglerBin };
  const statements = getPurgeStatements();
  for (const sql of statements) {
    logger.log(JSON.stringify({ event: "purge-statement", sql: sql.replace(/\s+/g, " ").trim() }));
    await executeD1(SOURCE_DB, sql, deps);
  }
  return { statements: statements.length };
}

export function verifyPurgeResults(afterCounts, targetCountsBeforePurge) {
  for (const table of SOURCE_CACHE_TABLES) {
    if ((afterCounts.source[table] ?? 0) !== 0) {
      throw new Error(`${table} still has ${afterCounts.source[table]} rows in ${SOURCE_DB}.`);
    }
  }
  for (const [name, count] of Object.entries(afterCounts.runtime)) {
    if (count !== 0) {
      throw new Error(`${name} still has ${count} runtime/job rows in ${SOURCE_DB}.`);
    }
  }
  for (const table of MIGRATED_CACHE_TABLES) {
    if ((afterCounts.target[table] ?? 0) < (targetCountsBeforePurge[table] ?? 0)) {
      throw new Error(`${table} row count in ${TARGET_DB} dropped during purge.`);
    }
  }
}

function requireRuntimeConfig(env) {
  const workerBaseUrl = normalizeBaseUrl(env.WORKER_BASE_URL);
  const adminSecret = String(env.ADMIN_SECRET ?? "").trim();
  if (!workerBaseUrl) throw new Error("Missing WORKER_BASE_URL.");
  if (!adminSecret) throw new Error("Missing ADMIN_SECRET.");
  return { workerBaseUrl, adminSecret };
}

function logSnapshot(logger, label, value) {
  logger.log(JSON.stringify({ event: label, ...value }, null, 2));
}

export async function runCleanup({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = fetch,
  commandRunner = defaultCommandRunner,
  logger = console,
} = {}) {
  const options = parseCliArgs(argv, env);
  if (options.help) {
    logger.log(usage());
    return { mode: "help" };
  }

  const { workerBaseUrl, adminSecret } = requireRuntimeConfig(env);
  const deps = {
    commandRunner,
    wranglerBin: env.WRANGLER_BIN,
  };

  const endpointStatusBefore = await fetchStatus({ workerBaseUrl, adminSecret, fetchImpl });
  logSnapshot(logger, "endpoint-status-before", endpointStatusBefore);

  const directCountsBefore = await loadDirectCounts(deps);
  logSnapshot(logger, "direct-counts-before", directCountsBefore);

  if (!options.backfill && !options.purge) {
    logger.log(JSON.stringify({
      event: "dry-run-complete",
      next: `Use --backfill to copy rows into ${TARGET_DB}, or --purge --confirm ${SOURCE_DB} to backfill, verify, and delete legacy rows.`,
    }));
    return { mode: "dry-run", endpointStatusBefore, directCountsBefore };
  }

  const backfill = await runBackfill({
    workerBaseUrl,
    adminSecret,
    limit: options.limit,
    stateFile: options.stateFile,
    fetchImpl,
    logger,
  });

  const endpointStatusAfterBackfill = await fetchStatus({ workerBaseUrl, adminSecret, fetchImpl });
  logSnapshot(logger, "endpoint-status-after-backfill", endpointStatusAfterBackfill);

  const directCountsAfterBackfill = await loadDirectCounts(deps);
  logSnapshot(logger, "direct-counts-after-backfill", directCountsAfterBackfill);
  verifyBackfillCoverage(directCountsBefore, directCountsAfterBackfill);

  const samples = await verifySampleKeys(deps);
  logSnapshot(logger, "sample-key-checks", { checked: samples.length, samples });

  if (!options.purge) {
    return { mode: "backfill", backfill, directCountsAfterBackfill, samples };
  }

  await runPurge({ commandRunner, wranglerBin: env.WRANGLER_BIN, logger });

  const directCountsAfterPurge = await loadDirectCounts(deps);
  logSnapshot(logger, "direct-counts-after-purge", directCountsAfterPurge);
  verifyPurgeResults(directCountsAfterPurge, directCountsAfterBackfill.target);

  const endpointStatusAfterPurge = await fetchStatus({ workerBaseUrl, adminSecret, fetchImpl });
  logSnapshot(logger, "endpoint-status-after-purge", endpointStatusAfterPurge);

  return {
    mode: "purge",
    backfill,
    directCountsAfterBackfill,
    directCountsAfterPurge,
    endpointStatusAfterPurge,
    samples,
  };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runCleanup().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
