import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupEodRunState } from "../src/eod-run-maintenance";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("bounded Ops retention against real SQLite", { timeout: 20_000 }, () => {
  let storage: ReturnType<typeof createSqliteD1>;
  let env: Env;
  const now = new Date("2026-09-08T00:00:00Z");
  beforeEach(async () => {
    storage = createSqliteD1();
    storage.migrate("ops-migrations");
    env = { DB: storage.db, OPS_DB: storage.db } as Env;
    const rows = [
      ["latest", "2026-09-08", "completed", 0], ["previous", "2026-09-07", "completed", 0],
      ["older", "2026-09-04", "completed", 0], ["expired-success", "2026-07-01", "completed", 0],
      ["expired-missed", "2026-07-02", "failed", 1], ["still-active", "2026-07-03", "retrying", 1],
    ];
    for (const [id, date, status, missed] of rows) {
      await storage.db.prepare(`INSERT INTO eod_runs(id,session_date,purpose,mode,status,deadline_missed,input_json,progress_json,created_at,updated_at)
        VALUES(?,?,'daily','active',?,?,'{"largeFrozenInputs":true}','{"largeDiagnostics":true}',?,?)`)
        .bind(id,date,status,missed,`${date}T00:00:00Z`,`${date}T00:00:00Z`).run();
      await storage.db.prepare("INSERT INTO eod_checkpoints(run_id,chunk_key,input_hash,payload_json,updated_at) VALUES(?,'features:0','hash','{}',?)")
        .bind(id,`${date}T00:00:00Z`).run();
    }
    await storage.db.batch([
      storage.db.prepare("INSERT INTO eod_budget_reservations VALUES('old-settled','2026-09-01','older',1,1,1,'2026-09-01T00:00:00Z')"),
      storage.db.prepare("INSERT INTO eod_budget_reservations VALUES('old-unsettled','2026-09-01','older',1,1,0,'2026-09-01T00:00:00Z')"),
      storage.db.prepare("INSERT INTO eod_budget_reservations VALUES('new-settled','2026-09-08','latest',1,1,1,'2026-09-08T00:00:00Z')"),
    ]);
  }, 30_000);
  afterEach(() => storage.dispose());

  it("keeps recent checkpoints and retry inputs while expiring recomputable old features", async () => {
    expect(await cleanupEodRunState(env, { now })).toEqual({ checkpointsDeleted: 4, reservationsDeleted: 1, runsDeleted: 1, summariesCompacted: 1 });
    expect((await storage.db.prepare("SELECT run_id as id FROM eod_checkpoints ORDER BY run_id").all()).results)
      .toEqual([{ id: "latest" }, { id: "previous" }]);
    expect(await storage.db.prepare("SELECT status,input_json FROM eod_runs WHERE id='still-active'").first())
      .toEqual({status:"retrying",input_json:'{"largeFrozenInputs":true}'});
    expect(await storage.db.prepare("SELECT input_json as inputs,progress_json as progress,deadline_missed as missed FROM eod_runs WHERE id='expired-missed'").first())
      .toEqual({ inputs: "{}", progress: JSON.stringify({ retentionSummary: 1, deadlineMissed: 1, compactedAt: now.toISOString() }), missed: 1 });
    expect((await storage.db.prepare("SELECT id FROM eod_budget_reservations ORDER BY id").all()).results)
      .toEqual([{ id: "new-settled" }, { id: "old-unsettled" }]);
    expect(await cleanupEodRunState(env, { now })).toEqual({ checkpointsDeleted: 0, reservationsDeleted: 0, runsDeleted: 0, summariesCompacted: 0 });
  });

  it("limits each retention category and makes progress across repeated passes", async () => {
    const first = await cleanupEodRunState(env, { now, maxRows: 1 });
    expect(Object.values(first).every((count) => count <= 1)).toBe(true);
    for (let index = 0; index < 4; index += 1) await cleanupEodRunState(env, { now, maxRows: 1 });
    expect(await storage.db.prepare("SELECT COUNT(*) as count FROM eod_checkpoints").first()).toEqual({ count: 2 });
  });

  it("preserves a healthy old lease and the durable history cursor",async () => {
    await storage.db.prepare("UPDATE eod_runs SET lease_until=? WHERE id='still-active'").bind(new Date(now.getTime()+60_000).toISOString()).run();
    await storage.db.prepare("INSERT INTO eod_checkpoints VALUES('still-active','history:cursor','hash','{\"nextTicker\":500}',?)").bind(now.toISOString()).run();
    await cleanupEodRunState(env,{now});
    expect((await storage.db.prepare("SELECT chunk_key FROM eod_checkpoints WHERE run_id='still-active' ORDER BY chunk_key").all()).results)
      .toEqual([{chunk_key:"features:0"},{chunk_key:"history:cursor"}]);
  });
});
