import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(scriptDir, "..");
const require = createRequire(import.meta.url);
const wranglerCliPath = require.resolve("wrangler/bin/wrangler.js");

export const SOURCE_DB = "market_command";
export const TARGET_DB = "market_prices";
export const DELETE_BATCH_SIZE = 1_000;
export const MAX_DELETE_ROWS = 10_000;
export const DELETE_SQL_PREFIX = "DELETE FROM daily_bars WHERE rowid IN";

function positiveInteger(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.trunc(parsed));
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parseCliArgs(argv = process.argv.slice(2), env = process.env) {
  const archiveAndPurge = argv.includes("--archive-and-purge");
  const confirm = optionValue(argv, "--confirm") ?? null;
  if (archiveAndPurge && confirm !== SOURCE_DB) {
    throw new Error(`Refusing production cleanup without --archive-and-purge --confirm ${SOURCE_DB}.`);
  }
  const batchSize = positiveInteger(
    optionValue(argv, "--batch-size") ?? env.LEGACY_DAILY_BARS_DELETE_BATCH_SIZE,
    DELETE_BATCH_SIZE,
    10_000,
  );
  const maxDeleteRows = positiveInteger(
    optionValue(argv, "--max-delete-rows") ?? env.LEGACY_DAILY_BARS_MAX_DELETE_ROWS,
    MAX_DELETE_ROWS,
    1_000_000,
  );
  const archiveDir = path.resolve(
    optionValue(argv, "--archive-dir")
      ?? env.LEGACY_DAILY_BARS_ARCHIVE_DIR
      ?? path.join(workerRoot, "tmp", "d1-archives"),
  );
  const stateFile = path.resolve(
    optionValue(argv, "--state-file")
      ?? env.LEGACY_DAILY_BARS_STATE_FILE
      ?? path.join(workerRoot, "tmp", "legacy-daily-bars-cleanup-state.json"),
  );
  return {
    archiveAndPurge,
    confirm,
    batchSize: Math.min(batchSize, maxDeleteRows),
    maxDeleteRows,
    archiveDir,
    stateFile,
  };
}

export async function defaultCommandRunner(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? workerRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}: ${stderr || stdout}`));
    });
  });
}

export function wranglerInvocation(args) {
  return {
    command: process.execPath,
    args: [wranglerCliPath, ...args],
  };
}

async function wrangler(commandRunner, args) {
  const invocation = wranglerInvocation(args);
  return commandRunner(invocation.command, invocation.args, { cwd: workerRoot });
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Could not parse ${label} JSON output.`);
  }
}

function resultBlock(raw, label) {
  const parsed = parseJson(raw, label);
  const block = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!block || block.success === false) throw new Error(`${label} did not return a successful result.`);
  return block;
}

async function d1Query(commandRunner, database, sql) {
  const { stdout } = await wrangler(commandRunner, [
    "d1",
    "execute",
    database,
    "--remote",
    "--json",
    "--command",
    sql,
  ]);
  return resultBlock(stdout, `${database} query`);
}

async function d1Info(commandRunner, database) {
  const { stdout } = await wrangler(commandRunner, ["d1", "info", database, "--json"]);
  return parseJson(stdout, `${database} info`);
}

function firstRow(block) {
  return block.results?.[0] ?? {};
}

function integer(value) {
  return Math.max(0, Math.trunc(Number(value ?? 0)));
}

async function loadLegacyStats(commandRunner) {
  const block = await d1Query(
    commandRunner,
    SOURCE_DB,
    `SELECT COUNT(*) AS rowCount,
            COUNT(DISTINCT ticker) AS tickerCount,
            MIN(date) AS minDate,
            MAX(date) AS maxDate,
            SUM(CASE WHEN date = (SELECT MAX(date) FROM daily_bars) THEN 1 ELSE 0 END) AS latestDateRows
     FROM daily_bars`,
  );
  const row = firstRow(block);
  return {
    rowCount: integer(row.rowCount),
    tickerCount: integer(row.tickerCount),
    minDate: row.minDate ?? null,
    maxDate: row.maxDate ?? null,
    latestDateRows: integer(row.latestDateRows),
  };
}

async function loadMarketStats(commandRunner, feed) {
  const escapedFeed = String(feed).replaceAll("'", "''");
  const block = await d1Query(
    commandRunner,
    TARGET_DB,
    `SELECT COUNT(*) AS rowCount,
            COUNT(DISTINCT ticker) AS tickerCount,
            MIN(date) AS minDate,
            MAX(date) AS maxDate,
            SUM(CASE WHEN date = (SELECT MAX(date) FROM alpaca_daily_bars WHERE feed = '${escapedFeed}') THEN 1 ELSE 0 END) AS latestDateRows
     FROM alpaca_daily_bars
     WHERE feed = '${escapedFeed}'`,
  );
  const row = firstRow(block);
  return {
    feed,
    rowCount: integer(row.rowCount),
    tickerCount: integer(row.tickerCount),
    minDate: row.minDate ?? null,
    maxDate: row.maxDate ?? null,
    latestDateRows: integer(row.latestDateRows),
  };
}

async function loadProtectedStats(commandRunner) {
  const block = await d1Query(
    commandRunner,
    SOURCE_DB,
    `SELECT
       (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table') AS tableCount,
       (SELECT COUNT(*) FROM symbols) AS symbolCount,
       (SELECT COUNT(*) FROM scan_snapshots) AS scanSnapshotCount,
       (SELECT COUNT(*) FROM scan_rows) AS scanRowCount`,
  );
  const row = firstRow(block);
  return {
    tableCount: integer(row.tableCount),
    symbolCount: integer(row.symbolCount),
    scanSnapshotCount: integer(row.scanSnapshotCount),
    scanRowCount: integer(row.scanRowCount),
  };
}

export async function loadWorkerConfig(root = workerRoot) {
  const source = await readFile(path.join(root, "wrangler.toml"), "utf8");
  const strictMatch = source.match(/^MARKET_DATA_DB_REQUIRED\s*=\s*"([^"]+)"/m);
  const feedMatch = source.match(/^ALPACA_DAILY_FEED\s*=\s*"([^"]+)"/m);
  return {
    marketDataRequired: /^(1|true|yes|on)$/i.test(strictMatch?.[1] ?? ""),
    feed: (feedMatch?.[1] ?? "sip").trim().toLowerCase() || "sip",
  };
}

export function validatePreflight(config, legacy, market) {
  if (!config.marketDataRequired) {
    throw new Error("MARKET_DATA_DB_REQUIRED must be true before legacy daily bars can be purged.");
  }
  if (legacy.rowCount === 0) return;
  if (market.rowCount === 0 || !market.maxDate) {
    throw new Error(`${TARGET_DB} has no canonical daily bars.`);
  }
  if (legacy.maxDate && market.maxDate < legacy.maxDate) {
    throw new Error(`${TARGET_DB} is stale (${market.maxDate}) relative to ${SOURCE_DB} (${legacy.maxDate}).`);
  }
  if (legacy.maxDate === market.maxDate && market.latestDateRows < legacy.latestDateRows) {
    throw new Error(
      `${TARGET_DB} latest-session coverage (${market.latestDateRows}) is below ${SOURCE_DB} (${legacy.latestDateRows}).`,
    );
  }
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function readState(stateFile) {
  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(stateFile, state) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function timeTravelBookmark(commandRunner) {
  const { stdout } = await wrangler(commandRunner, ["d1", "time-travel", "info", SOURCE_DB, "--json"]);
  const parsed = parseJson(stdout, `${SOURCE_DB} Time Travel`);
  const bookmark = parsed.bookmark ?? parsed.result?.bookmark ?? null;
  if (!bookmark) throw new Error(`Could not retrieve a Time Travel bookmark for ${SOURCE_DB}.`);
  return bookmark;
}

function archiveTimestamp(now) {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function createArchive(commandRunner, options, preflight, now) {
  await mkdir(options.archiveDir, { recursive: true });
  const bookmark = await timeTravelBookmark(commandRunner);
  const baseName = `${SOURCE_DB}-daily_bars-${archiveTimestamp(now)}`;
  const archivePath = path.join(options.archiveDir, `${baseName}.sql`);
  const manifestPath = path.join(options.archiveDir, `${baseName}.json`);
  await wrangler(commandRunner, [
    "d1",
    "export",
    SOURCE_DB,
    "--remote",
    "--table",
    "daily_bars",
    "--output",
    archivePath,
  ]);
  const archiveStat = await stat(archivePath);
  if (archiveStat.size <= 0) throw new Error("The daily_bars archive is empty; refusing to purge.");
  const checksum = await sha256(archivePath);
  const manifest = {
    version: 1,
    createdAt: now.toISOString(),
    sourceDatabase: SOURCE_DB,
    targetDatabase: TARGET_DB,
    table: "daily_bars",
    bookmark,
    archivePath,
    archiveBytes: archiveStat.size,
    sha256: checksum,
    preflight,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { archivePath, manifestPath, bookmark, archiveBytes: archiveStat.size, checksum };
}

async function verifyArchive(state) {
  if (!state?.archive?.archivePath || !state.archive.checksum) {
    throw new Error("Cleanup state does not contain a verified daily_bars archive.");
  }
  const archiveStat = await stat(state.archive.archivePath);
  if (archiveStat.size <= 0) throw new Error("The saved daily_bars archive is empty.");
  const checksum = await sha256(state.archive.archivePath);
  if (checksum !== state.archive.checksum) {
    throw new Error("The saved daily_bars archive checksum no longer matches; refusing to purge.");
  }
}

export function buildDeleteSql(limit) {
  const safeLimit = positiveInteger(limit, DELETE_BATCH_SIZE, 10_000);
  return `${DELETE_SQL_PREFIX} (SELECT rowid FROM daily_bars ORDER BY rowid LIMIT ${safeLimit})`;
}

export function isPausableCleanupError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /daily row write limit|write limit|overloaded|too many requests|timed? ?out|timeout|network|internal|\b429\b|\b5\d\d\b/i.test(message);
}

async function deleteBatch(commandRunner, limit) {
  const block = await d1Query(commandRunner, SOURCE_DB, buildDeleteSql(limit));
  return integer(block.meta?.changes ?? block.meta?.rows_written);
}

export async function inspectCleanup({ commandRunner = defaultCommandRunner, root = workerRoot } = {}) {
  const config = await loadWorkerConfig(root);
  const [legacy, market, protectedStats, sourceInfo, targetInfo] = await Promise.all([
    loadLegacyStats(commandRunner),
    loadMarketStats(commandRunner, config.feed),
    loadProtectedStats(commandRunner),
    d1Info(commandRunner, SOURCE_DB),
    d1Info(commandRunner, TARGET_DB),
  ]);
  validatePreflight(config, legacy, market);
  return {
    config,
    legacy,
    market,
    protectedStats,
    databaseSizes: {
      sourceBytes: integer(sourceInfo.database_size),
      targetBytes: integer(targetInfo.database_size),
    },
  };
}

export async function runCleanup({
  argv = process.argv.slice(2),
  env = process.env,
  commandRunner = defaultCommandRunner,
  logger = console,
  root = workerRoot,
  now = new Date(),
} = {}) {
  const options = parseCliArgs(argv, env);
  const preflight = await inspectCleanup({ commandRunner, root });
  logger.log(JSON.stringify({ event: "legacy-daily-bars-preflight", ...preflight }, null, 2));
  if (!options.archiveAndPurge || preflight.legacy.rowCount === 0) {
    return { status: preflight.legacy.rowCount === 0 ? "complete" : "audit", preflight, deletedThisRun: 0 };
  }

  let state = await readState(options.stateFile);
  if (!state) {
    const archive = await createArchive(commandRunner, options, preflight, now);
    state = {
      version: 1,
      sourceDatabase: SOURCE_DB,
      targetDatabase: TARGET_DB,
      table: "daily_bars",
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      totalDeleted: 0,
      completed: false,
      archive,
      protectedStatsBefore: preflight.protectedStats,
    };
    await writeState(options.stateFile, state);
    logger.log(JSON.stringify({ event: "legacy-daily-bars-archive-created", ...archive }, null, 2));
  } else {
    if (state.sourceDatabase !== SOURCE_DB || state.table !== "daily_bars") {
      throw new Error("Cleanup state targets a different database or table.");
    }
    await verifyArchive(state);
    logger.log(JSON.stringify({ event: "legacy-daily-bars-archive-verified", archivePath: state.archive.archivePath }));
  }

  let deletedThisRun = 0;
  while (deletedThisRun < options.maxDeleteRows) {
    const limit = Math.min(options.batchSize, options.maxDeleteRows - deletedThisRun);
    let changed;
    try {
      changed = await deleteBatch(commandRunner, limit);
    } catch (error) {
      if (!isPausableCleanupError(error)) throw error;
      state = {
        ...state,
        updatedAt: new Date().toISOString(),
        pausedReason: error instanceof Error ? error.message : String(error),
      };
      await writeState(options.stateFile, state);
      logger.error(JSON.stringify({ event: "legacy-daily-bars-cleanup-paused", reason: state.pausedReason }));
      return { status: "paused", preflight, deletedThisRun, state };
    }
    deletedThisRun += changed;
    state = {
      ...state,
      updatedAt: new Date().toISOString(),
      pausedReason: null,
      totalDeleted: integer(state.totalDeleted) + changed,
    };
    await writeState(options.stateFile, state);
    logger.log(JSON.stringify({
      event: "legacy-daily-bars-delete-batch",
      batchDeleted: changed,
      deletedThisRun,
      totalDeleted: state.totalDeleted,
    }));
    if (changed === 0 || changed < limit) break;
  }

  const postflight = await inspectCleanup({ commandRunner, root });
  const completed = postflight.legacy.rowCount === 0;
  state = {
    ...state,
    updatedAt: new Date().toISOString(),
    completed,
    completedAt: completed ? new Date().toISOString() : null,
    remainingRows: postflight.legacy.rowCount,
    databaseSizesAfter: postflight.databaseSizes,
    protectedStatsAfter: postflight.protectedStats,
  };
  await writeState(options.stateFile, state);
  logger.log(JSON.stringify({ event: "legacy-daily-bars-postflight", completed, deletedThisRun, ...postflight }, null, 2));
  return { status: completed ? "complete" : "partial", preflight, postflight, deletedThisRun, state };
}
