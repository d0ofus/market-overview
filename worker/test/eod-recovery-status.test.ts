import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { EOD_CONFIGURATION_KEY, EOD_CONTROLLER_STATUS_KEY, loadEodRecoveryStatus, registerEodRecoveryRoutes, storeEodControllerReport } from "../src/eod-recovery-status";
import type { Env } from "../src/types";

const oldRevision = "a".repeat(40), revision = "b".repeat(40), target = "00000000-0000-4000-8000-000000000002";
const now = new Date("2026-09-11T12:00:00Z"), migrationId = "market-storage:2026-09-08:aaaaaaaaaaaa";
const report = { version: 1, status: "paused", stage: "start", reason: "storage-preflight-insufficient-headroom",
  nextAttemptAt: null, updatedAt: "2026-09-11T11:30:00Z", codeRevision: oldRevision };
describe("admin recovery evidence on actual Ops schema", { timeout: 30_000 }, () => {
  let storage: ReturnType<typeof createSqliteD1>, env: Env;
  beforeAll(() => { storage = createSqliteD1(); storage.migrate("ops-migrations"); }, 30_000);
  afterAll(() => storage.dispose());
  beforeEach(() => {
    storage.script("DELETE FROM eod_rollout_evidence; DELETE FROM market_storage_migrations;");
    env = { DB: storage.db, OPS_DB: storage.db, EOD_RUNNER_MODE: "shadow", EOD_READ_ENABLED: "false" };
  });
  const evidence = async (id: string, value: unknown) => storage.db.prepare(
    "INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json,updated_at=excluded.updated_at")
    .bind(id, JSON.stringify(value), now.toISOString()).run();
  async function cutover() {
    env.EOD_RUNNER_MODE = "active"; env.EOD_READ_ENABLED = "true"; env.EOD_CODE_REVISION = revision; env.EOD_STORAGE_MIGRATION_ID = migrationId;
    await storage.db.prepare(`INSERT INTO market_storage_migrations(id,source_database_id,target_database_id,history_database_id,
      session_date,code_revision,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'completed',?,?)`)
      .bind(migrationId, "source", target, "history", "2026-09-08", oldRevision, now.toISOString(), now.toISOString()).run();
    await evidence("monitoring:public-activation", { version: 1, activatedAt: "2026-09-09T22:00:00Z", codeRevision: oldRevision, marketDatabaseId: target });
  }
  it("reports the actual pre-migration pause without requiring a migration ID", async () => {
    await storeEodControllerReport(storage.db, report, now);
    const status = await loadEodRecoveryStatus(env, now);
    expect(status.controller).toMatchObject({ status: "paused", reason: report.reason, stale: false });
    expect(status.configuration.status).toBe("pending"); expect(status.activation).toBeNull();
  });
  it("retains observation time on replays and rejects an older overwrite", async () => {
    await storeEodControllerReport(storage.db, report, now);
    await storeEodControllerReport(storage.db, report, now);
    await storeEodControllerReport(storage.db, { ...report, updatedAt: "2026-09-10T00:00:00Z", status: "running" }, now);
    expect((await loadEodRecoveryStatus(env, now)).controller?.updatedAt).toBe(report.updatedAt);
    await expect(storeEodControllerReport(storage.db, { ...report, secret: "do-not-publish" }, now)).rejects.toThrow();
    await expect(storeEodControllerReport(storage.db, { ...report, updatedAt: "2027-01-01T00:00:00Z" }, now)).rejects.toThrow("future");
  });
  it("marks absent heartbeat stale while respecting an explicit future quota retry", async () => {
    await storeEodControllerReport(storage.db, { ...report, updatedAt: "2026-09-09T00:00:00Z" }, now);
    expect((await loadEodRecoveryStatus(env, now)).controller?.stale).toBe(true);
    await storeEodControllerReport(storage.db, { ...report, status: "waiting", nextAttemptAt: "2026-09-12T00:05:00Z" }, now);
    expect((await loadEodRecoveryStatus(env, now)).controller?.stale).toBe(false);
  });
  it("does not treat a completed diagnostic as cutover or recorded configuration", async () => {
    await storeEodControllerReport(storage.db, { ...report, status: "completed", stage: "public-cutover" }, now);
    const status = await loadEodRecoveryStatus(env, now);
    expect(status.activation).toBeNull(); expect(status.configuration.status).toBe("pending");
  });
  it("allows a verified later configuration revision and permanent historical completion", async () => {
    await cutover();
    await storeEodControllerReport(storage.db, { ...report, status: "completed", stage: "public-cutover", updatedAt: "2026-09-09T22:00:00Z" }, now);
    const config = { version: 1, codeRevision: revision, activationCodeRevision: oldRevision, recordedAt: "2026-09-10T00:00:00Z",
      marketDatabaseId: target, migrationId, workerVersion: "00000000-0000-4000-8000-000000000003" };
    await evidence(EOD_CONFIGURATION_KEY, config);
    const status = await loadEodRecoveryStatus(env, now);
    expect(status.controller?.stale).toBe(false); expect(status.configuration.status).toBe("recorded");
    expect(status.configuration.codeRevision).not.toBe(status.activation?.codeRevision);
    env.EOD_CODE_REVISION = "c".repeat(40);
    expect((await loadEodRecoveryStatus(env, now)).configuration.status).toBe("mismatch");
    env.EOD_READ_ENABLED = "false";
    expect((await loadEodRecoveryStatus(env, now)).activation).toBeNull();
  });
  it("treats malformed stored data as unknown instead of exposing it", async () => {
    await evidence(EOD_CONTROLLER_STATUS_KEY, { ...report, stage: "private-value\nsecret" });
    expect((await loadEodRecoveryStatus(env, now)).controller).toBeNull();
  });
  it("requires admin auth and returns a sanitized unavailable response on database errors", async () => {
    const app = new Hono<{ Bindings: Env }>(); registerEodRecoveryRoutes(app);
    expect((await app.request("/api/admin/eod/recovery-status", {}, env)).status).toBe(401);
    env.ADMIN_SECRET = "test-only-secret";
    const good = await app.request("/api/admin/eod/recovery-status", { headers: { Authorization: "Bearer test-only-secret" } }, env);
    expect(good.status).toBe(200); expect(good.headers.get("cache-control")).toBe("no-store");
    env.OPS_DB = { prepare() { throw new Error("private database error"); } } as unknown as D1Database;
    const failed = await app.request("/api/admin/eod/recovery-status", { headers: { Authorization: "Bearer test-only-secret" } }, env);
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("private database error");
  });
});
