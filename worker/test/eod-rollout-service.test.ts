import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertEodCutover, validateEodCutoverEvidence, validateEodRetirementEvidence, type EodCutoverEvidence } from "../src/eod-rollout-service";
import { EOD_PUBLICATION_SCOPES } from "../src/eod-coordinator";
import { EOD_METRICS_VERSION } from "../src/eod-metrics";
import { MARKET_HISTORY_REQUIRED_CONSUMERS } from "../src/eod-history-maintenance";
import { encodeEodPayload, eodPayloadSummary } from "../src/eod-publication-codec";
import { eodHash } from "../src/eod-publication-service";
import { EOD_CATALOG_METHODOLOGY_VERSION, EOD_CATALOG_SCOPE, type EodCatalogPayload } from "../src/eod-catalog-service";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const revision = "a".repeat(40);
const now = new Date("2026-11-27T23:30:00Z");
function evidence(): EodCutoverEvidence {
  return {
    version: 1, codeRevision: revision, methodologyVersion: EOD_METRICS_VERSION,
    measuredAt: "2026-11-27T23:00:00Z", sessionDate: "2026-11-27", runId: "eod:shadow:2026-11-27:daily",
    sharedTickers: { count: 60, processed: 60 },
    fullUniverseCounts: EOD_PUBLICATION_SCOPES.slice(1).map((scope) => ({
      universeId: scope.slice(8) as EodCutoverEvidence["fullUniverseCounts"][number]["universeId"], memberCount: 10, attemptedCount: 10, observedCount: 10,
    })),
    scopes: EOD_PUBLICATION_SCOPES.map((scope) => ({ scope, publicationId: `proof-${scope}`, sessionDate: "2026-11-27" })),
    measurements: { usageDate: "2026-11-27", eodRowsRead: 100_000, eodRowsWritten: 20_000,
      accountRowsRead: 200_000, accountRowsWritten: 30_000, httpCpuMs: 5, coordinatorCpuMs: 8,
      queriesPerInvocation: 30, queryDurationMs: 20, source: "https://example.test/measured-run-artifacts" },
    limits: { httpCpuMs: 10, coordinatorCpuMs: 10, queriesPerInvocation: 50, queryDurationMs: 30_000 },
    capacity: { measuredAt: "2026-11-27T23:00:00Z", marketDatabaseBytes: 50_000_000, priceTableAndIndexBytes: 40_000_000,
      priceRows: 100_000, retainedPriceRows: 60 * 270, archiveDatabaseBytes: 20_000_000, additionalArchiveBytes: 10_000_000 },
    readers: { contractVersion: 1, checkedAt: "2026-11-27T22:00:00Z", consumers: [...MARKET_HISTORY_REQUIRED_CONSUMERS], parityPassed: true },
    retention: { hotSessions: 260, sweepHeadroomSessions: 10 },
  };
}

describe("bounded cutover proof validation", () => {
  it("allows one measured full-scope cutover without requiring ten sessions", () => {
    expect(validateEodCutoverEvidence(evidence(), revision, now).sessionDate).toBe("2026-11-27");
  });
  it("rejects missing proof, wrong code, stale measurements and inflated provider ceilings", () => {
    expect(() => validateEodCutoverEvidence({}, revision, now)).toThrow(/invalid-schema/);
    expect(() => validateEodCutoverEvidence(evidence(), "b".repeat(40), now)).toThrow(/code-revision/);
    expect(() => validateEodCutoverEvidence(evidence(), revision, new Date("2026-11-29T23:30:00Z"))).toThrow(/expired/);
    const proof = evidence(); proof.limits.coordinatorCpuMs = 300_000;
    expect(() => validateEodCutoverEvidence(proof, revision, now)).toThrow(/invalid-schema/);
  });
  it.each(["eodRowsRead", "eodRowsWritten", "accountRowsRead", "accountRowsWritten"] as const)("rejects over-budget %s", (metric) => {
    const proof = evidence(); proof.measurements[metric] = 9_000_000;
    expect(() => validateEodCutoverEvidence(proof, revision, now)).toThrow(/invalid-schema/);
  });
  it("rejects measured CPU/query overruns, missing scopes, partial catalog processing and missing sweep headroom", () => {
    for (const mutate of [
      (proof: EodCutoverEvidence) => { proof.measurements.httpCpuMs = 11; },
      (proof: EodCutoverEvidence) => { proof.measurements.coordinatorCpuMs = 11; },
      (proof: EodCutoverEvidence) => { proof.measurements.queriesPerInvocation = 51; },
      (proof: EodCutoverEvidence) => { proof.measurements.queryDurationMs = 30_000; },
      (proof: EodCutoverEvidence) => { proof.scopes[5] = proof.scopes[0]!; },
      (proof: EodCutoverEvidence) => { proof.sharedTickers.processed = 50; },
      (proof: EodCutoverEvidence) => { proof.capacity.retainedPriceRows = 60 * 260; },
      (proof: EodCutoverEvidence) => { proof.readers.consumers = ["overview"]; },
    ]) { const proof = evidence(); mutate(proof); expect(() => validateEodCutoverEvidence(proof, revision, now)).toThrow(); }
  });
  it("requires ten consecutive exchange sessions, deadlines and budgets only for retirement", () => {
    const dates = ["2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27"];
    const proof = { version: 1, codeRevision: revision, methodologyVersion: EOD_METRICS_VERSION,
      sessions: dates.map((sessionDate) => ({ sessionDate, runId: `eod:active:${sessionDate}:daily`,
        deadlineAt: `${sessionDate}T23:00:00Z`, publishedAt: `${sessionDate}T22:00:00Z`,
        scopes: evidence().scopes.map((scope) => ({ ...scope, sessionDate, publicationId: `${scope.publicationId}-${sessionDate}` })),
        measurements: { ...evidence().measurements, usageDate: sessionDate }, limits: evidence().limits })) };
    expect(validateEodRetirementEvidence(proof, revision, dates).sessions).toHaveLength(10);
    expect(() => validateEodRetirementEvidence({ ...proof, sessions: proof.sessions.slice(1) }, revision, dates)).toThrow(/retirement-schema/);
    proof.sessions[0]!.sessionDate = "2026-11-12";
    expect(() => validateEodRetirementEvidence(proof, revision, dates)).toThrow(/consecutive/);
    proof.sessions[0]!.sessionDate = dates[0]!;
    proof.sessions[0]!.publishedAt = "2026-11-14T00:00:00Z";
    expect(() => validateEodRetirementEvidence(proof, revision, dates)).toThrow(/deadline/);
  });
});

describe("cutover proof against actual migrated SQLite references", { timeout: 30_000 }, () => {
  let storage: ReturnType<typeof createSqliteD1>;
  let env: Env;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    storage = createSqliteD1(); storage.migrate("market-data-migrations"); storage.migrate("ops-migrations");
    env = { DB: storage.db, MARKET_DATA_DB: storage.db, MARKET_HISTORY_DB: storage.db, OPS_DB: storage.db, EOD_RUNNER_MODE: "active" } as Env;
    const proof = evidence();
    const memberships = proof.fullUniverseCounts.map((entry) => ({ universeId: entry.universeId, versionId: `v-${entry.universeId}`,
      members: Array.from({ length: 10 }, (_, index) => `${entry.universeId}-${index}`) }));
    const tickers = [...memberships.flatMap((entry) => entry.members), ...Array.from({ length: 10 }, (_, index) => `catalog-${index}`)];
    await storage.db.prepare(`INSERT INTO eod_runs(id,session_date,purpose,mode,status,input_json,progress_json,created_at,updated_at,completed_at,completed_input_clock)
      VALUES(?,?,'daily','shadow','completed',?,?,'2026-11-27T21:00:00Z','2026-11-27T22:00:00Z','2026-11-27T22:00:00Z',0)`)
      .bind(proof.runId, proof.sessionDate, JSON.stringify({ methodologyVersion: EOD_METRICS_VERSION, memberships, tickers }),
        JSON.stringify({ symbols: 60, published: proof.scopes.map((scope) => scope.publicationId), catalogPublicationId: "proof-catalog" })).run();
    for (const scope of proof.scopes) {
      const payload = scope.scope === "overview:default" ? { status: "ready", freshnessCurrentCount: 4 }
        : { publishable: true, metrics: { memberCount: 10, totalUniverseMembers: 10 }, membership: { versionId: `v-${scope.scope.slice(8)}` } };
      const encoded = await encodeEodPayload(payload);
      await storage.db.prepare(`INSERT INTO eod_publications(id,scope,session_date,revision,input_hash,methodology_version,payload_json,payload_checksum,payload_codec,payload_base64,status,created_at)
        VALUES(?,?,?,1,?,?,?,?,?,?,'candidate','2026-11-27T22:00:00Z')`)
        .bind(scope.publicationId, scope.scope, scope.sessionDate, scope.publicationId, EOD_METRICS_VERSION,
          eodPayloadSummary(payload), await eodHash(payload), encoded.payloadCodec, encoded.payloadBase64).run();
    }
    const catalog: EodCatalogPayload = { schemaVersion: 1, sessionDate: proof.sessionDate,
      methodologyVersion: EOD_CATALOG_METHODOLOGY_VERSION,
      rows: tickers.map((ticker) => [ticker, 0, null, null, null, null, 0, null, null, null]),
      compatibility: { schemaVersion: 1, rows: tickers.map((ticker) => [ticker,null,null,null]) } };
    await storage.db.prepare(`INSERT INTO eod_publications(id,scope,session_date,revision,input_hash,methodology_version,
      payload_json,payload_checksum,payload_codec,status,created_at)
      VALUES('proof-catalog',?,?,1,'catalog-hash',?,?,?,'json','candidate','2026-11-27T22:00:00Z')`)
      .bind(EOD_CATALOG_SCOPE, proof.sessionDate, EOD_CATALOG_METHODOLOGY_VERSION, JSON.stringify(catalog), await eodHash(catalog)).run();
    await storage.db.prepare("INSERT INTO eod_usage(usage_date,rows_read,rows_written) VALUES(?,100000,20000)").bind(proof.measurements.usageDate).run();
    await storage.db.prepare("INSERT INTO eod_account_usage(usage_date,rows_read,rows_written,sampled_at) VALUES(?,200000,30000,?)")
      .bind(proof.measurements.usageDate, proof.measuredAt).run();
    await storage.db.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES('cutover',?,?)").bind(JSON.stringify(proof), proof.measuredAt).run();
  }, 30_000);
  afterEach(() => { storage?.dispose(); vi.useRealTimers(); });
  async function alterCatalog(mutate: (catalog: EodCatalogPayload) => void) {
    const stored = await storage.db.prepare("SELECT payload_json FROM eod_publications WHERE id='proof-catalog'").first<{payload_json:string}>();
    const catalog = JSON.parse(stored!.payload_json) as EodCatalogPayload;
    mutate(catalog);
    await storage.db.prepare("UPDATE eod_publications SET payload_json=?,payload_checksum=? WHERE id='proof-catalog'")
      .bind(JSON.stringify(catalog), await eodHash(catalog)).run();
  }
  it("accepts completed shadow candidates with verified compressed payloads, counts and recorded quota", async () => {
    expect((await assertEodCutover(env, revision))?.sharedTickers.count).toBe(60);
  });
  it("requires the completed watermark and rejects later Yahoo corrections before initial cutover",async () => {
    await storage.db.prepare("UPDATE eod_runs SET completed_input_clock=NULL").run();
    await expect(assertEodCutover(env,revision)).rejects.toThrow("completed-inputs-changed");
    await storage.db.prepare("UPDATE eod_runs SET completed_input_clock=0").run();
    await storage.db.prepare("INSERT INTO eod_input_revisions(feed,ticker,revision) VALUES('yahoo-eod','catalog-0',1)").run();
    await expect(assertEodCutover(env,revision)).rejects.toThrow("completed-inputs-changed");
    expect(await storage.db.prepare("SELECT id FROM eod_rollout_evidence WHERE id=?").bind(`active:${revision}`).first()).toBeNull();
  });
  it("does not block shadow work or treat absence of a proof as approval for active work", async () => {
    await storage.db.prepare("DELETE FROM eod_rollout_evidence").run();
    expect(await assertEodCutover({ ...env, EOD_RUNNER_MODE: "shadow" }, "")).toBeNull();
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/proof-required/);
  });
  it("keeps exact-revision approval valid on day two without refreshing proof timestamps, and requires new proof for changed code", async () => {
    await assertEodCutover(env, revision);
    const stored = await storage.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(`active:${revision}`).first<{evidence_json:string}>();
    expect(JSON.parse(stored!.evidence_json).proofHash).toMatch(/^[a-f0-9]{64}$/);
    vi.setSystemTime(new Date("2026-11-29T23:30:00Z"));
    expect((await assertEodCutover(env, revision))?.measuredAt).toBe("2026-11-27T23:00:00Z");
    await expect(assertEodCutover(env, "b".repeat(40))).rejects.toThrow(/code-revision/);
  });
  it("rejects a fake full-catalog count or unrecorded quota assertion", async () => {
    await storage.db.prepare("UPDATE eod_runs SET progress_json=json_set(progress_json,'$.symbols',50)").run();
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/shared-catalog-count/);
    await storage.db.prepare("UPDATE eod_runs SET progress_json=json_set(progress_json,'$.symbols',60)").run();
    await storage.db.prepare("UPDATE eod_account_usage SET rows_read=4900000").run();
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/recorded-usage/);
  });
  it("rejects missing/altered publication records", async () => {
    await storage.db.prepare("UPDATE eod_publications SET payload_checksum='tampered' WHERE scope='overview:default'").run();
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/publication-integrity/);
  });
  it("requires the completed run's compact catalog reference without adding a seventh page scope", async () => {
    await storage.db.prepare("UPDATE eod_runs SET progress_json=json_remove(progress_json,'$.catalogPublicationId')").run();
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/catalog-publication-required/);
    expect(evidence().scopes).toHaveLength(6);
  });
  it.each(["scope", "session_date", "methodology_version", "payload_codec", "status"] as const)("rejects an incompatible catalog %s", async (column) => {
    // The column comes from this fixed test enum, never user input.
    await storage.db.prepare(`UPDATE eod_publications SET ${column}=? WHERE id='proof-catalog'`)
      .bind(column === "status" ? "rejected" : "invalid").run();
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/catalog-publication-reference/);
  });
  it("requires accepted catalog metadata for an active proof run", async () => {
    await storage.db.prepare("UPDATE eod_runs SET mode='active'").run();
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/catalog-publication-reference/);
    await storage.db.prepare("UPDATE eod_publications SET status='accepted'").run();
    expect((await assertEodCutover(env, revision))?.scopes).toHaveLength(6);
  });
  it("checks the catalog checksum before trusting its rows", async () => {
    await storage.db.prepare("UPDATE eod_publications SET payload_checksum='altered' WHERE id='proof-catalog'").run();
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/catalog-publication-integrity/);
  });
  it.each(["missing", "duplicate", "unexpected"] as const)("rejects %s frozen catalog tickers", async (kind) => {
    await alterCatalog((catalog) => {
      if (kind === "missing") catalog.rows.pop();
      else if (kind === "duplicate") catalog.rows[1] = catalog.rows[0]!;
      else catalog.rows[0]![0] = "UNEXPECTED";
    });
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/catalog-publication-population/);
  });
  it("rejects fabricated prices on a zero-history row", async () => {
    await alterCatalog((catalog) => { catalog.rows[0]![4] = 123; });
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/catalog-publication-coverage/);
  });
  it("rejects an old ten-tuple catalog without compatibility metadata at cutover", async () => {
    await alterCatalog((catalog) => { delete catalog.compatibility; });
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/catalog-publication-schema/);
  });
  it.each(["missing", "duplicate", "unexpected"] as const)("rejects %s compatibility tickers", async (kind) => {
    await alterCatalog((catalog) => {
      const rows = catalog.compatibility!.rows;
      if (kind === "missing") rows.pop();
      else if (kind === "duplicate") rows[1] = rows[0]!;
      else rows[0]![0] = "UNEXPECTED";
    });
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/catalog-compatibility-population/);
  });
  it("validates compatibility dates and count semantics before accepting a non-empty catalog", async () => {
    await alterCatalog((catalog) => {
      const ticker = catalog.rows[0]![0];
      catalog.rows[0] = [ticker,7,"2026-11-18","2026-11-27",7,700,0,6,100,100];
      catalog.compatibility!.rows[0] = [ticker,"2026-11-27",16.6667,"2026-11-18"];
    });
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/catalog-compatibility-coverage/);
    await alterCatalog((catalog) => {catalog.compatibility!.rows[0]![1]="2026-11-25";catalog.compatibility!.rows[0]![3]="2026-11-17";});
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/catalog-compatibility-coverage/);
    await alterCatalog((catalog) => {catalog.compatibility!.rows[0]![3]="2026-11-25";});
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/catalog-compatibility-coverage/);
    await alterCatalog((catalog) => {catalog.compatibility!.rows[0]![3]="2026-11-18";catalog.rows[0]![1]=2;});
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/catalog-compatibility-coverage/);
    await alterCatalog((catalog) => {catalog.rows[0]![1]=7;});
    expect((await assertEodCutover(env, revision))?.sharedTickers.count).toBe(60);
  });
  it("checks current SIP revisions and incomplete adjustment repairs before initial approval", async () => {
    await storage.db.prepare("INSERT INTO eod_input_revisions(feed,ticker,revision) VALUES('sip','catalog-0',1)").run();
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/catalog-publication-inputs-changed/);
    await alterCatalog((catalog) => { catalog.rows.find((row) => row[0] === "catalog-0")![6] = 1; });
    await storage.db.prepare(`INSERT INTO eod_adjustment_repairs(feed,ticker,status,start_date,updated_at)
      VALUES('sip','catalog-0','pending','2026-01-01','2026-11-27T23:00:00Z')`).run();
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/catalog-publication-inputs-changed/);
    await storage.db.prepare("UPDATE eod_adjustment_repairs SET status='complete'").run();
    await expect(assertEodCutover(env, revision)).rejects.toThrow(/completed-inputs-changed/);
    await storage.db.prepare("UPDATE eod_runs SET completed_input_clock=(SELECT revision FROM eod_input_clock WHERE id='default')").run();
    expect((await assertEodCutover(env, revision))?.sharedTickers.count).toBe(60);
  });
});
