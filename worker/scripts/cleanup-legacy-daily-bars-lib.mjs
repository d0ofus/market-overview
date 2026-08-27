import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(scriptDir, "..");
const require = createRequire(import.meta.url);
const wranglerCliPath = require.resolve("wrangler/bin/wrangler.js");

export const SOURCE_DB = "market_command";
export const TARGET_DB = "market_prices";
export const OPS_DB = "market_ops";
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
  const archiveAndDrop = argv.includes("--archive-and-drop");
  const dropPreflight = argv.includes("--drop-preflight");
  if (archiveAndPurge && archiveAndDrop) {
    throw new Error("Choose exactly one cleanup operation: --archive-and-purge or --archive-and-drop.");
  }
  const confirm = optionValue(argv, "--confirm") ?? null;
  if ((archiveAndPurge || archiveAndDrop) && confirm !== SOURCE_DB) {
    const operation = archiveAndDrop ? "--archive-and-drop" : "--archive-and-purge";
    throw new Error(`Refusing production cleanup without ${operation} --confirm ${SOURCE_DB}.`);
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
    archiveAndDrop,
    dropPreflight,
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
  const existsBlock = await d1Query(
    commandRunner,
    SOURCE_DB,
    "SELECT COUNT(*) AS tableCount FROM sqlite_master WHERE type = 'table' AND name = 'daily_bars'",
  );
  if (integer(firstRow(existsBlock).tableCount) === 0) {
    return { rowCount: 0, tickerCount: 0, minDate: null, maxDate: null, latestDateRows: 0, exists: false };
  }
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
    exists: true,
  };
}

async function loadLegacyDefinition(commandRunner) {
  const block = await d1Query(
    commandRunner,
    SOURCE_DB,
    `SELECT type, name, sql
       FROM sqlite_master
      WHERE tbl_name = 'daily_bars'
        AND type IN ('table', 'index')
      ORDER BY type, name`,
  );
  return block.results ?? [];
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
       (SELECT COUNT(*) FROM scan_rows) AS scanRowCount,
       (SELECT group_concat(ticker || ':' || COALESCE(name, ''), '|') FROM (
          SELECT ticker, name FROM symbols ORDER BY ticker LIMIT 100
        )) AS symbolSample,
       (SELECT group_concat(id, '|') FROM (
          SELECT id FROM scan_snapshots ORDER BY id LIMIT 100
        )) AS scanSnapshotSample`,
  );
  const row = firstRow(block);
  const sampleHash = createHash("sha256")
    .update(`${row.symbolSample ?? ""}\n${row.scanSnapshotSample ?? ""}`)
    .digest("hex");
  return {
    tableCount: integer(row.tableCount),
    symbolCount: integer(row.symbolCount),
    scanSnapshotCount: integer(row.scanSnapshotCount),
    scanRowCount: integer(row.scanRowCount),
    sampleHash,
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

export async function assertNoLegacyDailyBarsRuntimeDependency(root = workerRoot) {
  const srcRoot = path.join(root, "src");
  let entries;
  try {
    entries = await readdir(srcRoot, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { checkedFiles: 0, matches: [] };
    throw error;
  }
  const matches = [];
  let checkedFiles = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const parent = entry.parentPath ?? entry.path ?? srcRoot;
    const filePath = path.join(parent, entry.name);
    const source = await readFile(filePath, "utf8");
    checkedFiles += 1;
    if (/\b(?:FROM|INTO|UPDATE|JOIN|DELETE\s+FROM)\s+daily_bars\b/i.test(source)) {
      matches.push(path.relative(root, filePath));
    }
  }
  if (matches.length > 0) {
    throw new Error(`Worker runtime still depends on core daily_bars: ${matches.join(", ")}.`);
  }
  return { checkedFiles, matches };
}

const UNIVERSE_COVERAGE_THRESHOLDS = {
  "sp500-core": 98,
  "nasdaq-core": 95,
  "nyse-core": 95,
  "russell2000-core": 95,
  "overall-market-proxy": 95,
};

async function loadDropReadiness(commandRunner, feed, throughDate) {
  const escapedFeed = String(feed).replaceAll("'", "''");
  const escapedDate = String(throughDate).replaceAll("'", "''");
  const criticalBlock = await d1Query(
    commandRunner,
    TARGET_DB,
    `SELECT ticker, COUNT(*) AS barCount, MAX(date) AS maxDate
       FROM alpaca_daily_bars
      WHERE feed = '${escapedFeed}'
        AND source_provider = 'alpaca'
        AND adjustment = 'split'
        AND ticker IN ('SPY','QQQ','IWM')
        AND date <= '${escapedDate}'
      GROUP BY ticker`,
  );
  const critical = criticalBlock.results ?? [];
  for (const ticker of ["SPY", "QQQ", "IWM"]) {
    const row = critical.find((candidate) => candidate.ticker === ticker);
    if (!row || integer(row.barCount) < 260 || row.maxDate !== throughDate) {
      throw new Error(`Canonical ${ticker} history is not complete through ${throughDate}.`);
    }
  }

  const overviewBlock = await d1Query(
    commandRunner,
    SOURCE_DB,
    `SELECT DISTINCT di.ticker
       FROM dashboard_items di
       JOIN dashboard_groups dg ON dg.id = di.group_id
       JOIN dashboard_sections ds ON ds.id = dg.section_id
       JOIN dashboard_configs dc ON dc.id = ds.config_id
      WHERE dc.is_default = 1 AND di.enabled = 1
        AND (ds.title LIKE '%Macro%' OR ds.title LIKE '%Equities%')
      ORDER BY di.ticker`,
  );
  const overviewTickers = (overviewBlock.results ?? []).map((row) => String(row.ticker).toUpperCase()).filter(Boolean);
  if (overviewTickers.length === 0) throw new Error("No active Overview tickers were found in the core database.");
  const catalogBlock = await d1Query(
    commandRunner,
    TARGET_DB,
    `WITH latest AS (
       SELECT symbols_json FROM overview_provider_catalog_cache
        WHERE provider_key = 'alpaca' ORDER BY catalog_date DESC LIMIT 1
     )
     SELECT CAST(value AS TEXT) AS ticker FROM latest, json_each(latest.symbols_json)`,
  );
  const catalogTickers = new Set((catalogBlock.results ?? []).map((row) => String(row.ticker).toUpperCase()));
  if (catalogTickers.size === 0) throw new Error("No validated Alpaca active-asset catalog is stored.");
  const supportedOverviewTickers = overviewTickers.filter((ticker) => catalogTickers.has(ticker));
  if (supportedOverviewTickers.length === 0) throw new Error("No active Overview tickers are supported by the Alpaca asset catalog.");
  const overviewHistory = [];
  for (let offset = 0; offset < supportedOverviewTickers.length; offset += 400) {
    const tickerSql = supportedOverviewTickers.slice(offset, offset + 400).map((ticker) => `'${ticker.replaceAll("'", "''")}'`).join(",");
    const block = await d1Query(
      commandRunner,
      TARGET_DB,
      `SELECT ticker, COUNT(*) AS barCount, MAX(date) AS maxDate
         FROM alpaca_daily_bars
        WHERE feed = '${escapedFeed}' AND source_provider = 'alpaca' AND adjustment = 'split'
          AND date <= '${escapedDate}' AND ticker IN (${tickerSql})
        GROUP BY ticker`,
    );
    overviewHistory.push(...(block.results ?? []));
  }
  const overviewByTicker = new Map(overviewHistory.map((row) => [String(row.ticker).toUpperCase(), row]));
  const incompleteOverview = supportedOverviewTickers.filter((ticker) => {
    const row = overviewByTicker.get(ticker);
    return !row || integer(row.barCount) < 260 || row.maxDate !== throughDate;
  });
  const overviewCoveragePct = ((supportedOverviewTickers.length - incompleteOverview.length) / supportedOverviewTickers.length) * 100;
  if (overviewCoveragePct < 98) {
    throw new Error(`Canonical Overview history coverage ${overviewCoveragePct.toFixed(2)}% is below 98%; incomplete: ${incompleteOverview.slice(0, 20).join(", ")}.`);
  }

  const membershipBlock = await d1Query(
    commandRunner,
    TARGET_DB,
    `SELECT u.id AS universeId, uvm.ticker
       FROM universes u
       JOIN universe_version_members uvm ON uvm.version_id = u.active_version_id
      WHERE u.id IN ('sp500-core','nasdaq-core','nyse-core','russell2000-core','overall-market-proxy')
      ORDER BY u.id, uvm.ticker`,
  );
  const membersByUniverse = new Map();
  for (const row of membershipBlock.results ?? []) {
    const rows = membersByUniverse.get(row.universeId) ?? [];
    rows.push(String(row.ticker).toUpperCase());
    membersByUniverse.set(row.universeId, rows);
  }
  const universes = [];
  for (const [universeId, thresholdPct] of Object.entries(UNIVERSE_COVERAGE_THRESHOLDS)) {
    const members = membersByUniverse.get(universeId) ?? [];
    if (members.length === 0) throw new Error(`No active membership is available for ${universeId}.`);
    let currentCount = 0;
    for (let offset = 0; offset < members.length; offset += 400) {
      const tickerSql = members.slice(offset, offset + 400)
        .map((ticker) => `'${ticker.replaceAll("'", "''")}'`)
        .join(",");
      const block = await d1Query(
        commandRunner,
        TARGET_DB,
        `SELECT COUNT(DISTINCT ticker) AS currentCount
           FROM alpaca_daily_bars
          WHERE feed = '${escapedFeed}'
            AND source_provider = 'alpaca'
            AND adjustment = 'split'
            AND date = '${escapedDate}'
            AND ticker IN (${tickerSql})`,
      );
      currentCount += integer(firstRow(block).currentCount);
    }
    const coveragePct = members.length > 0 ? (currentCount / members.length) * 100 : 0;
    if (coveragePct < thresholdPct) {
      throw new Error(`${universeId} canonical coverage ${coveragePct.toFixed(2)}% is below ${thresholdPct}% on ${throughDate}.`);
    }
    universes.push({ universeId, memberCount: members.length, currentCount, coveragePct, thresholdPct });
  }
  return {
    throughDate,
    critical,
    overview: {
      configuredCount: overviewTickers.length,
      supportedCount: supportedOverviewTickers.length,
      completeCount: supportedOverviewTickers.length - incompleteOverview.length,
      coveragePct: overviewCoveragePct,
      incompleteTickers: incompleteOverview,
      unsupportedCount: overviewTickers.length - supportedOverviewTickers.length,
    },
    universes,
  };
}

export function validateProtectedStats(before, after, droppedTable = false) {
  const expectedTableCount = Math.max(0, integer(before.tableCount) - (droppedTable ? 1 : 0));
  if (integer(after.tableCount) !== expectedTableCount) {
    throw new Error(`Protected table count changed unexpectedly (${before.tableCount} -> ${after.tableCount}).`);
  }
  for (const key of ["symbolCount", "scanSnapshotCount", "scanRowCount"]) {
    if (integer(after[key]) !== integer(before[key])) {
      throw new Error(`Protected ${key} changed unexpectedly (${before[key]} -> ${after[key]}).`);
    }
  }
  if (before.sampleHash && after.sampleHash !== before.sampleHash) {
    throw new Error("Protected sampled-row hash changed unexpectedly.");
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
  const definitions = await loadLegacyDefinition(commandRunner);
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
    definitions,
    restoreCommand: `wrangler d1 time-travel restore ${SOURCE_DB} --bookmark ${bookmark}`,
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

async function dropLegacyTable(commandRunner) {
  const block = await d1Query(commandRunner, SOURCE_DB, "DROP TABLE daily_bars");
  return integer(block.meta?.changes ?? block.meta?.rows_written);
}

async function runRecoveryCanaries(commandRunner) {
  const canaryKey = `recovery-canary-${crypto.randomUUID()}`;
  await d1Query(
    commandRunner,
    SOURCE_DB,
    `INSERT INTO config_audit (id, config_id, action, actor, payload_json, created_at)
     VALUES ('${canaryKey}', 'default', 'RECOVERY_CANARY', 'recovery-script', '{}', CURRENT_TIMESTAMP)`,
  );
  const usageBucket = new Date().toISOString().slice(0, 16);
  await d1Query(
    commandRunner,
    OPS_DB,
    `INSERT INTO provider_budget_counters (provider_key, window_kind, window_bucket, request_count, updated_at)
     VALUES ('recovery-canary', 'minute', '${usageBucket}', 1, CURRENT_TIMESTAMP)
     ON CONFLICT(provider_key, window_kind, window_bucket) DO UPDATE SET
       request_count = provider_budget_counters.request_count + 1, updated_at = CURRENT_TIMESTAMP`,
  );
  await d1Query(commandRunner, OPS_DB, "DELETE FROM provider_budget_counters WHERE provider_key = 'recovery-canary'");
  await d1Query(
    commandRunner,
    SOURCE_DB,
    `DELETE FROM config_audit WHERE id = '${canaryKey}'`,
  );
  const marketRead = await d1Query(
    commandRunner,
    TARGET_DB,
    "SELECT ticker, MAX(date) AS maxDate FROM alpaca_daily_bars WHERE feed = 'sip' AND source_provider = 'alpaca' AND ticker IN ('SPY','QQQ','IWM') GROUP BY ticker",
  );
  if ((marketRead.results ?? []).length !== 3) {
    throw new Error("Post-drop market-data canary did not find current canonical history for SPY, QQQ, and IWM.");
  }
}

async function restoreTimeTravelBookmark(commandRunner, bookmark) {
  await wrangler(commandRunner, ["d1", "time-travel", "restore", SOURCE_DB, "--bookmark", bookmark, "--yes"]);
}

export async function inspectCleanup({ commandRunner = defaultCommandRunner, root = workerRoot } = {}) {
  const config = await loadWorkerConfig(root);
  const [legacy, market, protectedStats, sourceInfo, targetInfo, runtimeDependencyCheck] = await Promise.all([
    loadLegacyStats(commandRunner),
    loadMarketStats(commandRunner, config.feed),
    loadProtectedStats(commandRunner),
    d1Info(commandRunner, SOURCE_DB),
    d1Info(commandRunner, TARGET_DB),
    assertNoLegacyDailyBarsRuntimeDependency(root),
  ]);
  validatePreflight(config, legacy, market);
  return {
    config,
    legacy,
    market,
    protectedStats,
    runtimeDependencyCheck,
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
  let preflight = await inspectCleanup({ commandRunner, root });
  if ((options.archiveAndDrop || options.dropPreflight) && preflight.legacy.rowCount > 0) {
    preflight = {
      ...preflight,
      dropReadiness: await loadDropReadiness(
        commandRunner,
        preflight.config.feed,
        preflight.legacy.maxDate,
      ),
    };
  }
  logger.log(JSON.stringify({ event: "legacy-daily-bars-preflight", ...preflight }, null, 2));
  if ((!options.archiveAndPurge && !options.archiveAndDrop) || preflight.legacy.rowCount === 0) {
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
      operation: options.archiveAndDrop ? "drop" : "purge",
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

  if (options.archiveAndDrop) {
    if (state.operation && state.operation !== "drop") {
      throw new Error("Cleanup state was created for bounded purge, not archive-and-drop.");
    }
    await verifyArchive(state);
    await dropLegacyTable(commandRunner);
    let postflight;
    try {
      postflight = await inspectCleanup({ commandRunner, root });
      if (postflight.legacy.exists !== false || postflight.legacy.rowCount !== 0) {
        throw new Error("daily_bars still exists after the drop operation.");
      }
      validateProtectedStats(state.protectedStatsBefore, postflight.protectedStats, true);
      await runRecoveryCanaries(commandRunner);
    } catch (error) {
      await restoreTimeTravelBookmark(commandRunner, state.archive.bookmark);
      state = {
        ...state,
        updatedAt: new Date().toISOString(),
        completed: false,
        rollbackCompleted: true,
        rollbackReason: error instanceof Error ? error.message : String(error),
      };
      await writeState(options.stateFile, state);
      throw new Error(`Post-drop validation failed and ${SOURCE_DB} was restored from Time Travel: ${state.rollbackReason}`);
    }
    state = {
      ...state,
      updatedAt: new Date().toISOString(),
      completed: true,
      completedAt: new Date().toISOString(),
      remainingRows: 0,
      databaseSizesAfter: postflight.databaseSizes,
      protectedStatsAfter: postflight.protectedStats,
      canariesPassed: true,
    };
    await writeState(options.stateFile, state);
    logger.log(JSON.stringify({ event: "legacy-daily-bars-drop-complete", ...postflight }, null, 2));
    return { status: "complete", preflight, postflight, deletedThisRun: preflight.legacy.rowCount, state };
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
  if (completed) validateProtectedStats(state.protectedStatsBefore, postflight.protectedStats, false);
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
