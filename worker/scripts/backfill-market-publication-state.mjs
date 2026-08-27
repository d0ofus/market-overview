import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const SOURCE_DB = "market_command";
const TARGET_DB = "market_prices";
const CONFIRMATION = "COPY MARKET PUBLICATION STATE TO market_prices";
const TABLES = [
  "universes",
  "universe_symbols",
  "universe_versions",
  "universe_version_members",
  "overview_generations",
  "overview_snapshot_pointer",
  "snapshots_meta",
  "snapshot_rows",
  "breadth_snapshots",
  "data_readiness",
];
const TARGET_ONLY_TABLES = ["breadth_generations", "breadth_publication_pointer"];
const BREADTH_PROVIDER_LABEL = "Alpaca SIP split-adjusted completed daily bars; Alpaca IEX exact-session fallback.";
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

function tableColumns(database, table) {
  return query(database, `PRAGMA table_info(${table})`).map((row) => String(row.name));
}

export function addExplicitInsertColumns(sql, table, columns) {
  if (columns.length === 0) throw new Error(`${table} has no source columns.`);
  const escapedTable = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const insertPattern = new RegExp(`INSERT\\s+INTO\\s+(?:\"${escapedTable}\"|${escapedTable})\\s+VALUES`, "gi");
  const columnList = columns.map((column) => `\"${column.replaceAll("\"", "\"\"")}\"`).join(", ");
  return sql.replace(insertPattern, `INSERT INTO \"${table}\" (${columnList}) VALUES`);
}

const confirmIndex = process.argv.indexOf("--confirm");
if (confirmIndex < 0 || process.argv[confirmIndex + 1] !== CONFIRMATION) {
  throw new Error(`Refusing cross-D1 backfill. Pass --confirm "${CONFIRMATION}".`);
}

const targetCounts = Object.fromEntries([...TABLES, ...TARGET_ONLY_TABLES].map((table) => [
  table,
  Number(query(TARGET_DB, `SELECT COUNT(*) AS count FROM ${table}`)[0]?.count ?? 0),
]));
const nonEmpty = Object.entries(targetCounts).filter(([, count]) => count > 0);
if (nonEmpty.length > 0) {
  throw new Error(`Target publication tables are not empty: ${nonEmpty.map(([table, count]) => `${table}=${count}`).join(", ")}.`);
}

const tempDir = await mkdtemp(path.join(tmpdir(), "market-publication-backfill-"));
try {
  for (const table of TABLES) {
    const output = path.join(tempDir, `${table}.sql`);
    const sourceColumns = tableColumns(SOURCE_DB, table);
    const targetColumns = new Set(tableColumns(TARGET_DB, table));
    const missingTargetColumns = sourceColumns.filter((column) => !targetColumns.has(column));
    if (missingTargetColumns.length > 0) {
      throw new Error(`${table} target schema is missing source columns: ${missingTargetColumns.join(", ")}.`);
    }
    run(["d1", "export", SOURCE_DB, "--remote", "--table", table, "--no-schema", "--output", output]);
    const exportedSql = await readFile(output, "utf8");
    const importSql = addExplicitInsertColumns(exportedSql, table, sourceColumns);
    if (sourceColumns.length > 0 && !importSql.includes(`INSERT INTO \"${table}\" (`) && exportedSql.includes("INSERT")) {
      throw new Error(`Could not add an explicit column list to ${table} export.`);
    }
    await writeFile(output, importSql, "utf8");
    run(["d1", "execute", TARGET_DB, "--remote", "--yes", "--file", output]);
  }
  query(
    TARGET_DB,
    `INSERT INTO breadth_generations
       (id, as_of_date, expected_as_of_date, generated_at, provider_label, status, health, warning)
     SELECT 'backfill:' || as_of_date, as_of_date, as_of_date, MAX(generated_at),
            '${BREADTH_PROVIDER_LABEL.replaceAll("'", "''")}', 'published', 'fresh', NULL
       FROM breadth_snapshots
      WHERE universe_id IN ('sp500-core', 'nasdaq-core', 'nyse-core', 'russell2000-core', 'overall-market-proxy')
      GROUP BY as_of_date
     HAVING COUNT(DISTINCT universe_id) = 5`,
  );
  query(
    TARGET_DB,
    `UPDATE breadth_snapshots
        SET generation_id = 'backfill:' || as_of_date
      WHERE EXISTS (
        SELECT 1 FROM breadth_generations generation
         WHERE generation.id = 'backfill:' || breadth_snapshots.as_of_date
           AND generation.status = 'published'
      )`,
  );
  query(
    TARGET_DB,
    `INSERT INTO breadth_publication_pointer (pointer_key, generation_id, updated_at)
     SELECT 'default', id, CURRENT_TIMESTAMP
       FROM breadth_generations
      WHERE status = 'published'
      ORDER BY as_of_date DESC, generated_at DESC
      LIMIT 1`,
  );
  const comparison = TABLES.map((table) => {
    const sourceCount = Number(query(SOURCE_DB, `SELECT COUNT(*) AS count FROM ${table}`)[0]?.count ?? 0);
    const targetCount = Number(query(TARGET_DB, `SELECT COUNT(*) AS count FROM ${table}`)[0]?.count ?? 0);
    if (sourceCount !== targetCount) throw new Error(`${table} backfill mismatch (${sourceCount} != ${targetCount}).`);
    return { table, sourceCount, targetCount };
  });
  process.stdout.write(`${JSON.stringify({ ok: true, source: SOURCE_DB, target: TARGET_DB, comparison }, null, 2)}\n`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
