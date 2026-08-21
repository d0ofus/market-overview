import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDeleteSql,
  parseCliArgs,
  runCleanup,
  validatePreflight,
  wranglerInvocation,
} from "../scripts/cleanup-legacy-daily-bars-lib.mjs";

const tempRoots: string[] = [];
const quietLogger = { log() {}, error() {} };

async function tempPaths() {
  const root = path.resolve(process.cwd(), "tmp", `legacy-daily-bars-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const archiveDir = path.join(root, "archives");
  const stateFile = path.join(root, "state.json");
  await mkdir(root, { recursive: true });
  tempRoots.push(root);
  return { root, archiveDir, stateFile };
}

function queryResponse(results: unknown[], changes = 0) {
  return JSON.stringify([{ results, success: true, meta: { changes, rows_written: changes } }]);
}

function createRunner(options: {
  legacyRows?: number;
  legacyMaxDate?: string;
  legacyLatestRows?: number;
  marketMaxDate?: string;
  marketLatestRows?: number;
  failExport?: boolean;
  failDelete?: string;
} = {}) {
  let legacyRows = options.legacyRows ?? 2_500;
  let exportCalls = 0;
  let deleteCalls = 0;
  const calls: string[][] = [];
  const runner = vi.fn(async (_command: string, args: string[]) => {
    calls.push(args);
    if (args.includes("info") && !args.includes("time-travel")) {
      const database = args[args.indexOf("info") + 1];
      return { stdout: JSON.stringify({ database_size: database === "market_command" ? 499_998_720 : 256_438_272 }), stderr: "" };
    }
    if (args.includes("time-travel")) {
      return { stdout: JSON.stringify({ bookmark: "bookmark-1" }), stderr: "" };
    }
    if (args.includes("export")) {
      exportCalls += 1;
      if (options.failExport) throw new Error("export failed");
      const output = args[args.indexOf("--output") + 1];
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, "INSERT INTO daily_bars VALUES ('AAA','2026-08-20',1,1,1,1,1,NULL,NULL,NULL);\n", "utf8");
      return { stdout: "exported", stderr: "" };
    }
    if (args.includes("execute")) {
      const database = args[args.indexOf("execute") + 1];
      const sql = args[args.indexOf("--command") + 1];
      if (sql.startsWith("DELETE FROM daily_bars")) {
        deleteCalls += 1;
        if (options.failDelete) throw new Error(options.failDelete);
        const limit = Number(sql.match(/LIMIT (\d+)/)?.[1] ?? 0);
        const changed = Math.min(legacyRows, limit);
        legacyRows -= changed;
        return { stdout: queryResponse([], changed), stderr: "" };
      }
      if (database === "market_command" && sql.includes("FROM daily_bars")) {
        return {
          stdout: queryResponse([{
            rowCount: legacyRows,
            tickerCount: legacyRows > 0 ? 10 : 0,
            minDate: legacyRows > 0 ? "2024-03-20" : null,
            maxDate: legacyRows > 0 ? (options.legacyMaxDate ?? "2026-08-20") : null,
            latestDateRows: legacyRows > 0 ? (options.legacyLatestRows ?? 100) : 0,
          }]),
          stderr: "",
        };
      }
      if (database === "market_prices") {
        return {
          stdout: queryResponse([{
            rowCount: 5_000,
            tickerCount: 20,
            minDate: "2024-06-21",
            maxDate: options.marketMaxDate ?? "2026-08-20",
            latestDateRows: options.marketLatestRows ?? 200,
          }]),
          stderr: "",
        };
      }
      if (sql.includes("scanSnapshotCount")) {
        return { stdout: queryResponse([{ tableCount: 130, symbolCount: 6_000, scanSnapshotCount: 33, scanRowCount: 2_303 }]), stderr: "" };
      }
    }
    throw new Error(`Unexpected Wrangler call: ${args.join(" ")}`);
  });
  return {
    runner,
    calls,
    get exportCalls() { return exportCalls; },
    get deleteCalls() { return deleteCalls; },
    get legacyRows() { return legacyRows; },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy daily-bars cleanup script", () => {
  it("launches Wrangler through Node instead of a Windows cmd shim", () => {
    const invocation = wranglerInvocation(["d1", "info", "market_command", "--json"]);
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args[0]).toMatch(/[\\/]wrangler[\\/]bin[\\/]wrangler\.js$/);
    expect(invocation.args.slice(1)).toEqual(["d1", "info", "market_command", "--json"]);
  });

  it("requires the exact production confirmation before purge mode", () => {
    expect(() => parseCliArgs(["--archive-and-purge"], {})).toThrow(/--confirm market_command/);
    expect(() => parseCliArgs(["--archive-and-purge", "--confirm", "market_prices"], {})).toThrow(/--confirm market_command/);
    expect(parseCliArgs(["--archive-and-purge", "--confirm", "market_command"], {})).toMatchObject({
      archiveAndPurge: true,
      confirm: "market_command",
      batchSize: 1_000,
      maxDeleteRows: 10_000,
    });
  });

  it("targets only daily_bars with a bounded rowid delete", () => {
    const sql = buildDeleteSql(1_000);
    expect(sql).toBe("DELETE FROM daily_bars WHERE rowid IN (SELECT rowid FROM daily_bars ORDER BY rowid LIMIT 1000)");
    expect(sql).not.toMatch(/DROP|ALTER|scan_|symbols/i);
  });

  it("refuses cleanup when the canonical market database is stale or has worse latest-session coverage", () => {
    const config = { marketDataRequired: true, feed: "sip" };
    const legacy = { rowCount: 100, maxDate: "2026-08-20", latestDateRows: 90 };
    expect(() => validatePreflight(config, legacy, { rowCount: 100, maxDate: "2026-08-19", latestDateRows: 100 })).toThrow(/is stale/);
    expect(() => validatePreflight(config, legacy, { rowCount: 100, maxDate: "2026-08-20", latestDateRows: 80 })).toThrow(/coverage/);
  });

  it("runs audit mode without exporting or deleting", async () => {
    const mock = createRunner();
    const result = await runCleanup({ argv: [], commandRunner: mock.runner, logger: quietLogger });
    expect(result.status).toBe("audit");
    expect(mock.exportCalls).toBe(0);
    expect(mock.deleteCalls).toBe(0);
    expect(mock.legacyRows).toBe(2_500);
  });

  it("archives once, purges in bounded runs, and resumes from verified state", async () => {
    const paths = await tempPaths();
    const mock = createRunner();
    const args = [
      "--archive-and-purge",
      "--confirm",
      "market_command",
      "--archive-dir",
      paths.archiveDir,
      "--state-file",
      paths.stateFile,
      "--max-delete-rows",
      "2000",
    ];

    const first = await runCleanup({ argv: args, commandRunner: mock.runner, logger: quietLogger });
    expect(first.status).toBe("partial");
    expect(first.deletedThisRun).toBe(2_000);
    expect(mock.exportCalls).toBe(1);
    expect(mock.legacyRows).toBe(500);

    const second = await runCleanup({ argv: args, commandRunner: mock.runner, logger: quietLogger });
    expect(second.status).toBe("complete");
    expect(second.deletedThisRun).toBe(500);
    expect(mock.exportCalls).toBe(1);
    expect(mock.legacyRows).toBe(0);
    expect(JSON.parse(await readFile(paths.stateFile, "utf8"))).toMatchObject({ completed: true, remainingRows: 0, totalDeleted: 2_500 });
  });

  it("never deletes when archive creation fails", async () => {
    const paths = await tempPaths();
    const mock = createRunner({ failExport: true });
    await expect(runCleanup({
      argv: ["--archive-and-purge", "--confirm", "market_command", "--archive-dir", paths.archiveDir, "--state-file", paths.stateFile],
      commandRunner: mock.runner,
      logger: quietLogger,
    })).rejects.toThrow(/export failed/);
    expect(mock.deleteCalls).toBe(0);
  });

  it("pauses safely and saves state on D1 overload", async () => {
    const paths = await tempPaths();
    const mock = createRunner({ failDelete: "D1 DB is overloaded. Too many requests queued." });
    const result = await runCleanup({
      argv: ["--archive-and-purge", "--confirm", "market_command", "--archive-dir", paths.archiveDir, "--state-file", paths.stateFile],
      commandRunner: mock.runner,
      logger: quietLogger,
    });
    expect(result.status).toBe("paused");
    expect(mock.legacyRows).toBe(2_500);
    expect(JSON.parse(await readFile(paths.stateFile, "utf8"))).toMatchObject({
      completed: false,
      pausedReason: expect.stringContaining("overloaded"),
    });
  });
});
