import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getPurgeStatements,
  parseCliArgs,
  runBackfill,
  runPurge,
} from "../scripts/cleanup-legacy-rs-cache-lib.mjs";

const tempRoots: string[] = [];
const quietLogger = { log() {}, error() {} };

async function makeStateFile() {
  const root = path.resolve(process.cwd(), "tmp", `legacy-rs-cache-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  tempRoots.push(root);
  return path.join(root, "state.json");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy RS cache cleanup script", () => {
  it("continues the backfill cursor loop until the worker reports done", async () => {
    const stateFile = await makeStateFile();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, copied: 1000, done: false, nextCursor: "cursor-1" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, copied: 25, done: true, nextCursor: null }));

    const result = await runBackfill({
      workerBaseUrl: "https://worker.example.com",
      adminSecret: "secret",
      limit: 1000,
      stateFile,
      fetchImpl: fetchMock,
      logger: quietLogger,
    });

    expect(result).toMatchObject({ batches: 2, copied: 1025, done: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ table: "all", limit: 1000 });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ table: "all", limit: 1000, cursor: "cursor-1" });
    await expect(readFile(stateFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes an interrupted backfill from the saved state cursor", async () => {
    const stateFile = await makeStateFile();
    await writeFile(stateFile, JSON.stringify({ cursor: "saved-cursor" }), "utf8");
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ ok: true, copied: 1, done: true, nextCursor: null }));

    await runBackfill({
      workerBaseUrl: "https://worker.example.com",
      adminSecret: "secret",
      stateFile,
      fetchImpl: fetchMock,
      logger: quietLogger,
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ cursor: "saved-cursor" });
  });

  it("blocks purge mode unless the market_command confirmation is present", () => {
    expect(() => parseCliArgs(["--purge"], {})).toThrow(/--purge --confirm market_command/);
    expect(() => parseCliArgs(["--purge", "--confirm", "market_rs"], {})).toThrow(/--purge --confirm market_command/);
    expect(parseCliArgs(["--purge", "--confirm", "market_command"], {})).toMatchObject({
      purge: true,
      backfill: true,
      confirm: "market_command",
    });
  });

  it("targets only legacy cache and runtime relative-strength rows for purge", () => {
    const sql = getPurgeStatements().join("\n");

    expect(sql).toContain("DELETE FROM rs_ratio_cache");
    expect(sql).toContain("DELETE FROM relative_strength_latest_cache");
    expect(sql).toContain("DELETE FROM relative_strength_config_state");
    expect(sql).toContain("DELETE FROM relative_strength_cache");
    expect(sql).toContain("DELETE FROM relative_strength_refresh_queue");
    expect(sql).toContain("DELETE FROM relative_strength_materialization_runs");
    expect(sql).toContain("DELETE FROM scan_refresh_jobs WHERE job_type = 'relative-strength'");
    expect(sql).toContain("scan_refresh_job_candidates");
    expect(sql).toContain("scan_refresh_job_top_rows");

    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bALTER\b/i);
    expect(sql).not.toMatch(/\bscan_presets\b/i);
    expect(sql).not.toMatch(/\bscan_snapshots\b/i);
    expect(sql).not.toMatch(/\bscan_rows\b/i);
    expect(sql).not.toMatch(/\brs_scan_runs\b/i);
    expect(sql).not.toMatch(/\brs_scan_rows_latest\b/i);
    expect(sql).not.toMatch(/\brs_features_latest\b/i);
  });

  it("runs purge statements through Wrangler against market_command only", async () => {
    const commandRunner = vi.fn().mockResolvedValue({ stdout: JSON.stringify([{ results: [] }]), stderr: "" });

    await runPurge({ commandRunner, logger: quietLogger });

    expect(commandRunner).toHaveBeenCalledTimes(getPurgeStatements().length);
    for (const call of commandRunner.mock.calls) {
      expect(call[0]).toBe("wrangler");
      expect(call[1]).toEqual(expect.arrayContaining(["d1", "execute", "market_command", "--remote", "--json", "--command"]));
      expect(call[1]).not.toContain("market_rs");
    }
  });
});
