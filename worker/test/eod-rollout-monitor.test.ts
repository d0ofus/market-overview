import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EOD_PUBLICATION_SCOPES } from "../src/eod-coordinator";
import { EOD_METRICS_VERSION } from "../src/eod-metrics";
import { eodRetirementSessionCutoff, EOD_RETIREMENT_POLICY_VERSION, EOD_ROLLOUT_MONITOR_KEY } from "../src/eod-retirement-policy";
import { collectEodRolloutMonitoring, finalizeEodUsageDay, finalizeRecentEodUsage, readEodRolloutMonitoring } from "../src/eod-rollout-monitor";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const dates = ["2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20",
  "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27"];
const now = new Date("2026-11-30T00:30:00Z");
const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;
const usage = (usageDate: string) => ({ version: 1, usageDate, sampledAt: "2026-11-30T00:00:00.000Z",
  finalizedAfter: new Date(Date.parse(`${usageDate}T00:00:00Z`) + 2 * 86_400_000).toISOString(),
  source: "cloudflare-account-analytics-and-metered-ledgers", eodRowsRead: 100, eodRowsWritten: 10,
  accountRowsRead: 1000, accountRowsWritten: 100, reservedReads: 0, reservedWrites: 0 });

describe("production delivery monitoring on migrated SQLite", { timeout: 30_000 }, () => {
  let storage: ReturnType<typeof createSqliteD1>, env: Env;
  beforeAll(() => {
    storage = createSqliteD1(); storage.migrate("market-data-migrations"); storage.migrate("ops-migrations");
    env = { DB: storage.db, MARKET_DATA_DB: storage.db, OPS_DB: storage.db, EOD_RUNNER_MODE: "active", EOD_READ_ENABLED: "true", EOD_CODE_REVISION: "a".repeat(40) } as Env;
  }, 30_000);
  afterAll(() => storage.dispose());
  beforeEach(() => {
    const statements = ["DELETE FROM eod_rollout_evidence", "DELETE FROM eod_runs", "DELETE FROM eod_publication_pointers", "DELETE FROM eod_publications",
      "DELETE FROM market_calendar_sessions", "DELETE FROM market_calendar_refresh_state",
      "DELETE FROM eod_usage", "DELETE FROM market_data_daily_usage", "DELETE FROM eod_account_usage", "UPDATE eod_input_clock SET revision=0",
      "INSERT INTO market_calendar_refresh_state VALUES('default','2026-01-01','2027-01-01','2026-11-29T00:00:00Z')"];
    for (const session of dates) {
      const close = session === "2026-11-27" ? "13:00" : "16:00", accepted = `${session}T${close === "13:00" ? "19" : "22"}:00:00.000Z`;
      statements.push(`INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source) VALUES('${session}','09:30','${close}','alpaca')`);
      statements.push(`INSERT INTO eod_runs(id,session_date,purpose,mode,status,created_at,updated_at,completed_at,completed_input_clock,progress_json)
        VALUES('eod:active:${session}:daily','${session}','daily','active','completed','${accepted}','${accepted}','${accepted}',0,
          ${quoted(JSON.stringify({ published: EOD_PUBLICATION_SCOPES.map((scope) => `${scope}:${session}`) }))})`);
      for (const scope of EOD_PUBLICATION_SCOPES) statements.push(`INSERT INTO eod_publications
        (id,scope,session_date,revision,input_hash,methodology_version,payload_json,payload_checksum,status,created_at,accepted_at)
        VALUES('${scope}:${session}','${scope}','${session}',1,'${scope}:${session}','${EOD_METRICS_VERSION}','{}','${"a".repeat(64)}','accepted','${accepted}','${accepted}')`);
    }
    for (let time = Date.parse(`${dates[0]}T00:00:00Z`); time <= Date.parse(`${dates.at(-1)}T00:00:00Z`); time += 86_400_000) {
      const day = new Date(time).toISOString().slice(0, 10);
      statements.push(`INSERT INTO eod_rollout_evidence VALUES('monitoring:utc-usage:${day}',${quoted(JSON.stringify(usage(day)))},'2026-11-30T00:00:00Z')`);
    }
    statements.push(`INSERT INTO eod_rollout_evidence VALUES('monitoring:public-activation',${quoted(JSON.stringify({
      version: 1, activatedAt: "2026-11-13T20:59:00Z", codeRevision: "a".repeat(40), marketDatabaseId: "a6dedc93-6ffc-4793-9b3d-0ef47e29c4b8",
    }))},'2026-11-13T20:59:00Z')`);
    storage.script(`${statements.join(";\n")};`);
    pointCurrent("2026-11-27", now);
  });
  function pointCurrent(session: string, checked: Date) {
    const day = checked.toISOString().slice(0,10), stamp = checked.toISOString();
    storage.script(`DELETE FROM eod_publication_pointers;
      ${EOD_PUBLICATION_SCOPES.map((scope) => `INSERT INTO eod_publication_pointers VALUES('${scope}','${scope}:${session}','${session}','${stamp}');`).join("\n")}
      INSERT OR REPLACE INTO eod_usage VALUES('${day}',100,10,0,0);
      INSERT OR REPLACE INTO eod_account_usage(usage_date,rows_read,rows_written,sampled_at) VALUES('${day}',1000,100,'${stamp}');
      INSERT OR REPLACE INTO market_data_daily_usage(usage_date,rows_read,rows_written) VALUES('${day}',1000,100);`);
  }

  it("requires no observed sessions and reports explicit current health alongside historical diagnostics", async () => {
    const result = await collectEodRolloutMonitoring(env, now);
    expect(result.eligibleForRetirement).toBe(true);
    expect(result).toMatchObject({ version: 3, policyVersion: EOD_RETIREMENT_POLICY_VERSION, requiredSessions: 0, currentHealth: { status: "passed", publicationCount: 6 } });
    expect(result.sessions.map((session) => session.sessionDate)).toEqual(["2026-11-24", "2026-11-25", "2026-11-27"]);
    expect(result.usageDays).toHaveLength(4);
    expect(result.usageDays.filter((day) => day.requiredForRetirement)).toHaveLength(0);
    expect(result.usageDays.find((day) => day.usageDate === "2026-11-26")?.requiredForRetirement).toBe(false);
    expect(result.sessions.at(-1)).toMatchObject({ sessionDate: "2026-11-27", deadlineAt: "2026-11-27T20:00:00.000Z",
      firstCompletePublicationAt: "2026-11-27T19:00:00.000Z", status: "passed" });
    expect((await readEodRolloutMonitoring(env, now))?.eligibleForRetirement).toBe(true);
  });
  it("uses the first accepted revision even after a later correction or unfinished catalog retry", async () => {
    storage.script(`INSERT INTO eod_publications(id,scope,session_date,revision,input_hash,methodology_version,payload_json,status,created_at,accepted_at)
      VALUES('correction','overview:default','2026-11-27',2,'corrected','${EOD_METRICS_VERSION}','{}','accepted','2026-11-28T12:00:00Z','2026-11-28T12:00:00Z');`);
    const result = await collectEodRolloutMonitoring(env, now);
    expect(result.eligibleForRetirement).toBe(true);
    expect(result.sessions.at(-1)?.scopes.find((scope) => scope.scope === "overview:default")?.publicationId).toBe("overview:default:2026-11-27");
  });
  it("cannot credit private bootstrap before public activation or a missing activation record", async () => {
    storage.script(`UPDATE eod_rollout_evidence SET evidence_json=json_set(evidence_json,'$.activatedAt','2026-11-27T19:30:00Z')
      WHERE id='monitoring:public-activation';`);
    const result = await collectEodRolloutMonitoring(env, now);
    expect(result.eligibleForRetirement).toBe(true);
    expect(result.sessions[0]?.reasons).toContain("public-publication-not-active-by-deadline");
    expect(result.sessions.at(-1)?.firstCompletePublicationAt).toBe("2026-11-27T19:30:00.000Z");
    storage.script("DELETE FROM eod_rollout_evidence WHERE id='monitoring:public-activation';");
    expect((await collectEodRolloutMonitoring(env, now)).reasons).toContain("public-activation-unverified");
  });
  it("does not hide a missing active run or a single missing universe", async () => {
    storage.script("DELETE FROM eod_runs WHERE session_date='2026-11-24'; DELETE FROM eod_publication_pointers WHERE scope='breadth:sp500-core'; DELETE FROM eod_publications WHERE scope='breadth:sp500-core' AND session_date='2026-11-27';");
    const result = await collectEodRolloutMonitoring(env, now);
    expect(result.eligibleForRetirement).toBe(false);
    expect(result.sessions.find((session) => session.sessionDate === "2026-11-24")?.reasons).toContain("active-daily-run-missing");
    expect(result.sessions.at(-1)?.missingScopes).toEqual(["breadth:sp500-core"]);
  });
  it("uses the actual early-close deadline and rejects an observation accepted before the session closed", async () => {
    storage.script("UPDATE eod_publications SET accepted_at='2026-11-27T21:00:00Z' WHERE session_date='2026-11-27';");
    expect((await collectEodRolloutMonitoring(env, now)).sessions.at(-1)?.lateScopes).toHaveLength(6);
    storage.script("UPDATE eod_publications SET accepted_at='2026-11-27T17:59:00Z' WHERE session_date='2026-11-27';");
    expect((await collectEodRolloutMonitoring(env, now)).eligibleForRetirement).toBe(false);
  });
  it("does not require holiday evidence but never substitutes an intraday trading-day sample", async () => {
    storage.script("DELETE FROM eod_rollout_evidence WHERE id='monitoring:utc-usage:2026-11-26';");
    let result = await collectEodRolloutMonitoring(env, now);
    expect(result.eligibleForRetirement).toBe(true);
    expect(result.usageDays.find((day) => day.usageDate === "2026-11-26")).toMatchObject({ status: "pending", requiredForRetirement: false });
    storage.script("UPDATE eod_rollout_evidence SET evidence_json=json_set(evidence_json,'$.sampledAt','2026-11-27T23:00:00Z') WHERE id='monitoring:utc-usage:2026-11-27';");
    result = await collectEodRolloutMonitoring(env, now);
    expect(result.sessions.at(-1)?.status).toBe("pending");
    expect(result.eligibleForRetirement).toBe(true);
  });
  it("has no minimum history window but never treats absent current publications as healthy", async () => {
    storage.script(`DELETE FROM market_calendar_sessions WHERE session_date<'2026-11-27';
      DELETE FROM eod_rollout_evidence WHERE id LIKE 'monitoring:utc-usage:%';`);
    const current = await collectEodRolloutMonitoring(env, now);
    expect(current.requiredSessions).toBe(0); expect(current.sessions).toHaveLength(1);
    expect(current.eligibleForRetirement).toBe(true);
    expect(current.operationalReasons).toContain("operational-calendar-history-incomplete");
    storage.script("DELETE FROM eod_publication_pointers;");
    const absent = await collectEodRolloutMonitoring(env, now);
    expect(absent.eligibleForRetirement).toBe(false); expect(absent.currentHealth?.publicationCount).toBe(0);
    expect(absent.reasons).toContain("current-publications-incomplete");
  });
  it("blocks on current corrections, unmatched run publications, quota reservations and stale account samples", async () => {
    storage.script("UPDATE eod_input_clock SET revision=1;");
    expect((await collectEodRolloutMonitoring(env, now)).reasons).toContain("current-input-corrections-pending");
    storage.script("UPDATE eod_input_clock SET revision=0; UPDATE eod_runs SET progress_json='{}' WHERE session_date='2026-11-27';");
    expect((await collectEodRolloutMonitoring(env, now)).reasons).toContain("current-publication-run-mismatch");
    storage.script("UPDATE eod_usage SET reserved_writes=90000 WHERE usage_date='2026-11-30';");
    expect((await collectEodRolloutMonitoring(env, now)).reasons).toContain("current-quota-headroom-unavailable");
    storage.script("UPDATE eod_account_usage SET sampled_at='2026-11-30T00:00:00Z';");
    expect((await collectEodRolloutMonitoring(env, now)).reasons).toContain("current-account-sample-stale");
  });
  it("retains missing and over-budget weekend telemetry without adding a weekend retirement check", async () => {
    storage.script(`DELETE FROM market_calendar_sessions WHERE session_date>'2026-11-24';
      DELETE FROM eod_rollout_evidence WHERE id='monitoring:utc-usage:2026-11-21';
      UPDATE eod_rollout_evidence SET evidence_json=json_set(evidence_json,'$.accountRowsWritten',9000000)
        WHERE id='monitoring:utc-usage:2026-11-22';`);
    pointCurrent("2026-11-24", now);
    const result = await collectEodRolloutMonitoring(env, now);
    expect(result.sessions.map((session) => session.sessionDate)).toEqual(["2026-11-20", "2026-11-23", "2026-11-24"]);
    expect(result.eligibleForRetirement).toBe(true);
    expect(result.usageDays.find((day) => day.usageDate === "2026-11-21")).toMatchObject({ status: "pending", requiredForRetirement: false });
    expect(result.usageDays.find((day) => day.usageDate === "2026-11-22")).toMatchObject({ status: "failed", requiredForRetirement: false });
    expect((await readEodRolloutMonitoring(env, now))?.eligibleForRetirement).toBe(true);
  });
  it.each([
    { at: "2026-11-25T00:30:00Z", expected: "2026-11-24", cutoff: "2026-11-23", sessions: ["2026-11-19", "2026-11-20", "2026-11-23"] },
    { at: "2026-11-26T00:30:00Z", expected: "2026-11-25", cutoff: "2026-11-24", sessions: ["2026-11-20", "2026-11-23", "2026-11-24"] },
  ])("passes on a weekday at $at using finalizable sessions while newer usage is pending", async ({ at, expected, cutoff, sessions }) => {
    const weekdayNow = new Date(at);
    pointCurrent(expected, weekdayNow);
    storage.script(`UPDATE eod_rollout_evidence SET evidence_json=json_set(evidence_json,'$.sampledAt',${quoted(`${at.slice(0,10)}T00:00:00.000Z`)})
        WHERE id LIKE 'monitoring:utc-usage:%';
      DELETE FROM eod_rollout_evidence WHERE id LIKE 'monitoring:utc-usage:%'
        AND (id>'monitoring:utc-usage:${cutoff}' OR id IN ('monitoring:utc-usage:2026-11-21','monitoring:utc-usage:2026-11-22'));`);
    const result = await collectEodRolloutMonitoring(env, weekdayNow);
    expect(eodRetirementSessionCutoff(expected, weekdayNow)).toBe(cutoff);
    expect(result).toMatchObject({ usageFinalizationCutoff: cutoff, latestEvaluatedSession: cutoff,
      eligibleForRetirement: true, consecutivePassedSessions: 3 });
    expect(result.sessions.map((session) => session.sessionDate)).toEqual(sessions);
    expect(result.newerSessions).toHaveLength(1);
    expect(result.newerSessions[0]).toMatchObject({ sessionDate: expected, status: "pending", missingScopes: [], lateScopes: [] });
    expect(result.usageDays.find((day) => day.usageDate === expected)).toMatchObject({ requiredForRetirement: false, status: "pending" });
    expect((await readEodRolloutMonitoring(env, weekdayNow))?.eligibleForRetirement).toBe(true);
    // The cutoff is calendar-based: absent eligible evidence cannot cause a
    // fallback to older cheap dates or be mistaken for unfinalizable new work.
    storage.script(`DELETE FROM eod_rollout_evidence WHERE id='monitoring:utc-usage:${cutoff}';`);
    const missing = await collectEodRolloutMonitoring(env, weekdayNow);
    expect(missing.sessions.map((session) => session.sessionDate)).toEqual(sessions);
    expect(missing.eligibleForRetirement).toBe(true);
  });
  it("retains a recovered late delivery diagnostic without adding an implicit waiting period", async () => {
    const weekdayNow = new Date("2026-11-26T00:30:00Z");
    pointCurrent("2026-11-25", weekdayNow);
    storage.script(`UPDATE eod_rollout_evidence SET evidence_json=json_set(evidence_json,'$.sampledAt','2026-11-26T00:00:00.000Z')
        WHERE id LIKE 'monitoring:utc-usage:%';
      DELETE FROM eod_rollout_evidence WHERE id LIKE 'monitoring:utc-usage:%' AND id>'monitoring:utc-usage:2026-11-24';
      UPDATE eod_publications SET accepted_at='2026-11-26T00:00:00Z' WHERE session_date='2026-11-25' AND scope='overview:default';`);
    const result = await collectEodRolloutMonitoring(env, weekdayNow);
    expect(result.consecutivePassedSessions).toBe(3);
    expect(result.eligibleForRetirement).toBe(true);
    expect(result.operationalReasons).toContain("newer-session-delivery-failed");
    expect(result.newerSessions[0]?.lateScopes).toEqual(["overview:default"]);
  });
  it.each(["eodRowsRead", "eodRowsWritten", "accountRowsRead", "accountRowsWritten"])("retains historical %s excess without an observation gate", async (field) => {
    storage.script(`UPDATE eod_rollout_evidence SET evidence_json=json_set(evidence_json,'$.${field}',9000000) WHERE id='monitoring:utc-usage:2026-11-25';`);
    const result = await collectEodRolloutMonitoring(env, now);
    expect(result.eligibleForRetirement).toBe(true); expect(result.operationalReasons).toContain("utc-operating-budget-exceeded");
  });
  it("keeps shadow mode and stale cached status ineligible", async () => {
    expect((await collectEodRolloutMonitoring({ ...env, EOD_RUNNER_MODE: "shadow" }, now)).eligibleForRetirement).toBe(false);
    await collectEodRolloutMonitoring(env, now);
    expect(await readEodRolloutMonitoring(env, new Date(now.getTime() + 360_000))).toMatchObject({ stale: false,
      eligibleForRetirement: false, currentHealth: { status: "pending", reasons: ["current-health-evidence-expired"] },
      reasons: ["current-health-evidence-expired"] });
    expect(await readEodRolloutMonitoring(env, new Date("2026-12-02T00:30:00Z"))).toMatchObject({ stale: true, eligibleForRetirement: false });
  });
  it("rejects calendar evidence that lacks the observed range", async () => {
    storage.script("UPDATE market_calendar_refresh_state SET covered_start='2026-11-25';");
    expect((await collectEodRolloutMonitoring(env, now)).operationalReasons).toContain("exchange-calendar-coverage-incomplete");
  });
  it("does not reuse an old ten-session cache or accept mismatched cached policy/counts", async () => {
    const result = await collectEodRolloutMonitoring(env, now);
    const old = { ...result, version: 1, requiredSessions: 10, consecutivePassedSessions: 10, eligibleForRetirement: true };
    delete (old as Partial<typeof result>).policyVersion;
    storage.script(`DELETE FROM eod_rollout_evidence WHERE id=${quoted(EOD_ROLLOUT_MONITOR_KEY)};
      INSERT INTO eod_rollout_evidence VALUES('monitoring:ten-sessions',${quoted(JSON.stringify(old))},${quoted(now.toISOString())});`);
    expect(await readEodRolloutMonitoring(env, now)).toBeNull();
    const { usageFinalizationCutoff: _, ...withoutCutoff } = result;
    for (const invalid of [old, withoutCutoff, { ...result, policyVersion: "ten-trading-sessions-v1" }, { ...result, requiredSessions: 10 }]) {
      storage.script(`INSERT OR REPLACE INTO eod_rollout_evidence VALUES(${quoted(EOD_ROLLOUT_MONITOR_KEY)},${quoted(JSON.stringify(invalid))},${quoted(now.toISOString())});`);
      expect(await readEodRolloutMonitoring(env, now)).toBeNull();
    }
  });
  it("finalizes an actual prior UTC bucket without redating its analytics sample or lowering recorded usage", async () => {
    storage.script("INSERT INTO eod_usage VALUES('2026-11-27',200,20,0,0); INSERT INTO market_data_daily_usage(usage_date,rows_read,rows_written) VALUES('2026-11-27',3000,200);");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { viewer: { accounts: [{
      d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 2000, rowsWritten: 190 } }],
    }] } } }));
    const result = await finalizeEodUsageDay({ accountId: "account", token: "fake", usageDate: "2026-11-27", ops: storage.db, now, fetcher });
    expect(result).toMatchObject({ sampledAt: now.toISOString(), eodRowsRead: 200, accountRowsRead: 3000, accountRowsWritten: 200 });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).variables).toMatchObject({ start: "2026-11-27", end: "2026-11-27" });
  });
  it("never finalizes an open day, missing ledger or outstanding reservations as zero", async () => {
    const fetcher = vi.fn<typeof fetch>(), input = { accountId: "account", token: "fake", usageDate: "2026-11-27", ops: storage.db, now, fetcher };
    await expect(finalizeEodUsageDay({ ...input, now: new Date("2026-11-28T23:59:00Z") })).rejects.toThrow("not-finalizable");
    await expect(finalizeEodUsageDay(input)).rejects.toThrow("ledger-missing");
    storage.script("INSERT INTO eod_usage VALUES('2026-11-27',200,20,1,0); INSERT INTO market_data_daily_usage(usage_date,rows_read,rows_written) VALUES('2026-11-27',3000,200);");
    await expect(finalizeEodUsageDay(input)).rejects.toThrow("unsettled");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("repairs an older missed bucket in its bounded third slot after an analytics outage", async () => {
    storage.script("DELETE FROM eod_rollout_evidence WHERE id='monitoring:utc-usage:2026-11-20';");
    for (const day of ["2026-11-20", "2026-11-27", "2026-11-28"]) storage.script(`
      INSERT INTO eod_usage VALUES('${day}',200,20,0,0);
      INSERT INTO market_data_daily_usage(usage_date,rows_read,rows_written) VALUES('${day}',3000,200);`);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: { viewer: { accounts: [{
      d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 3000, rowsWritten: 200 } }],
    }] } } }));
    const result = await finalizeRecentEodUsage({ accountId: "account", token: "fake", ops: storage.db, now, fetcher });
    expect(result).toEqual(["2026-11-28", "2026-11-27", "2026-11-20"].map((usageDate) => ({ usageDate, status: "recorded" })));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
