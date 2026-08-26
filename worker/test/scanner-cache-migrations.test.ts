import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("scanner cache post-close migration", () => {
  const sql = readFileSync(new URL("../scanner-cache-migrations/0009_rs_post_close_precompute.sql", import.meta.url), "utf8");

  it("adds backward-compatible generation, retry, timing, immutable result, and publication metadata", () => {
    for (const column of [
      "source_post_close_job_id", "universe_fingerprint", "provider_fetch_ms", "storage_read_ms",
      "math_compute_ms", "storage_write_ms", "continuation_wait_ms", "attempt_count", "last_error",
      "rs_ratio_close", "rs_ratio_ma", "approx_rs_rating",
    ]) expect(sql).toContain(column);
    expect(sql).toContain("DEFAULT 0");
    expect(sql).toContain("idx_rs_scan_runs_config_date_completed");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS rs_preset_publications");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS rs_publications");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS rs_publication_tickers");
    expect(sql).toContain("UNIQUE (publication_id, rank)");
    expect(sql).toContain("publication_id TEXT NOT NULL");
    expect(sql).toContain("preset_id TEXT PRIMARY KEY");
  });

  it("keeps the manual ready-generation path free of provider rematerialization", () => {
    const source = readFileSync(new URL("../src/scans-page-service.ts", import.meta.url), "utf8");
    const branchStart = source.indexOf("const completed = await loadLatestCompletedManualRelativeStrengthRunForConfig", source.indexOf("export async function requestScansRefresh"));
    const branch = source.slice(branchStart, source.indexOf("const run = await createManualRelativeStrengthRun", branchStart));
    expect(branch).toContain("publishRelativeStrengthPresetFromCompletedRun");
    expect(branch).not.toContain("fetchRelativeStrengthPrefilterRows");
    expect(branch).not.toContain("createManualRelativeStrengthRun");
    expect(source).toContain("COALESCE(t.rs_ratio_close, f.rs_ratio_close)");
    expect(source).toContain("LEFT JOIN rs_features_latest f");
    expect(source).toContain("JOIN rs_scan_run_tickers t ON t.run_id = ? AND t.ticker = m.ticker");
    const publishStart = source.indexOf("export async function publishRelativeStrengthPresetFromCompletedRun");
    const publishBranch = source.slice(publishStart, source.indexOf("async function listActiveRelativeStrengthPresetsForManualRunConfig", publishStart));
    expect(publishBranch).not.toContain("storeScanSnapshotResult");
    expect(publishBranch).not.toContain("env.DB");
  });
});
