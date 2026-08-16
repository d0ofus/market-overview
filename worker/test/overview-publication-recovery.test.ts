import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

const recoveryMocks = vi.hoisted(() => ({
  compute: vi.fn(),
}));

vi.mock("../src/eod", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/eod")>(),
  computeAndStoreSnapshot: recoveryMocks.compute,
}));

import { auditOverviewFreshnessState, reconcileOverviewPublication } from "../src/overview-publication-recovery";

type Generation = {
  generationId: string;
  asOfDate: string;
  generatedAt: string;
  providerLabel: string;
  expectedAsOfDate: string;
  status: "ready" | "rejected";
  publicationQuality: "ready" | "degraded" | "bootstrap" | "rejected";
  freshnessStatus: "fresh" | "partial" | "stale";
  freshnessCoveragePct: number;
  freshnessCurrentCount: number;
  freshnessEligibleCount: number;
  freshnessCriticalMissingJson: string;
  freshnessMinBarDate: string;
  freshnessMaxBarDate: string;
  freshnessWarning: string | null;
  quoteOverlayRequestedCount: number;
  quoteOverlayReturnedCount: number;
  quoteOverlayError: string | null;
  quoteOverlayMissingSampleJson: string;
  sourceCycleId: string;
  publicationCoveragePct: number;
  publicationCriticalMissingJson: string;
};

function generation(id: string, status: "ready" | "rejected" = "ready"): Generation {
  return {
    generationId: id,
    asOfDate: "2026-07-21",
    generatedAt: "2026-07-21T21:00:00.000Z",
    providerLabel: "stored-only",
    expectedAsOfDate: "2026-07-21",
    status,
    publicationQuality: status === "ready" ? "ready" : "rejected",
    freshnessStatus: status === "ready" ? "fresh" : "stale",
    freshnessCoveragePct: 100,
    freshnessCurrentCount: 225,
    freshnessEligibleCount: 225,
    freshnessCriticalMissingJson: "[]",
    freshnessMinBarDate: "2026-07-21",
    freshnessMaxBarDate: "2026-07-21",
    freshnessWarning: status === "ready" ? null : "coverage blocked",
    quoteOverlayRequestedCount: 225,
    quoteOverlayReturnedCount: status === "ready" ? 225 : 180,
    quoteOverlayError: null,
    quoteOverlayMissingSampleJson: "[]",
    sourceCycleId: "cycle-1",
    publicationCoveragePct: status === "ready" ? 100 : 80,
    publicationCriticalMissingJson: "[]",
  };
}

class PrimaryDb {
  generations = new Map<string, Generation>();
  pointer: string | null = null;
  readiness: { generationId: string | null; status: string; coveragePct: number | null; warning: string | null; updatedAt: string } | null = null;
  scheduledMetadata: string | null = null;
  scheduledAuditWrites = 0;

  prepare(sql: string) {
    let args: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => {
        args = values;
        return statement;
      },
      first: async <T>() => {
        if (sql.includes("JOIN overview_snapshot_pointer")) {
          return (this.pointer ? this.generations.get(this.pointer) ?? null : null) as T;
        }
        if (sql.includes("g.source_cycle_id = ?")) {
          return (Array.from(this.generations.values()).find((row) => row.sourceCycleId === args[2]) ?? null) as T;
        }
        if (sql.includes("FROM data_readiness")) return this.readiness as T;
        if (sql.includes("FROM scheduled_job_runs")) {
          return (this.scheduledMetadata ? { metadataJson: this.scheduledMetadata } : null) as T;
        }
        return null as T;
      },
      run: async () => {
        if (sql.includes("INSERT INTO overview_snapshot_pointer")) this.pointer = String(args[1]);
        if (sql.includes("INSERT INTO data_readiness")) {
          this.readiness = {
            generationId: args[3] == null ? null : String(args[3]),
            status: String(args[4]),
            coveragePct: args[5] == null ? null : Number(args[5]),
            warning: args[6] == null ? null : String(args[6]),
            updatedAt: "2026-07-21T21:00:00.000Z",
          };
        }
        if (sql.includes("INSERT INTO scheduled_job_runs")) {
          this.scheduledMetadata = args[5] == null ? null : String(args[5]);
          this.scheduledAuditWrites += 1;
        }
        if (sql.includes("UPDATE scheduled_job_runs") && args[2] != null) {
          this.scheduledMetadata = String(args[2]);
        }
        return { meta: { changes: 1 } };
      },
    };
    return statement;
  }
}

class MarketDb {
  prepare(_sql: string) {
    const statement = {
      bind: (..._args: unknown[]) => statement,
      first: async <T>() => ({
        configId: "default",
        sessionDate: "2026-07-21",
        status: "completed",
        attemptCount: 3,
        nextAttemptAt: null,
        updatedAt: "2026-07-21T20:55:00.000Z",
        cycleId: "cycle-1",
        cycleStartedAt: "2026-07-21T20:30:00.000Z",
        cursorOffset: 0,
        processedTickers: 225,
        requestedTickers: 225,
        freshTickers: 225,
        unavailableTickers: 0,
        leaseExpiresAt: null,
        lastError: null,
        lastErrorCode: null,
      }) as T,
    };
    return statement;
  }
}

function createEnv(primary: PrimaryDb): Env {
  return {
    DB: primary as unknown as D1Database,
    MARKET_DATA_DB: new MarketDb() as unknown as D1Database,
    OVERVIEW_PUBLICATION_RECOVERY_ENABLED: "true",
  } as Env;
}

describe("overview source-cycle publication recovery", () => {
  beforeEach(() => {
    recoveryMocks.compute.mockReset();
  });

  it("publishes one generation for repeated reconciliation of the same source cycle", async () => {
    const primary = new PrimaryDb();
    const env = createEnv(primary);
    recoveryMocks.compute.mockImplementation(async (_env, _date, _configId, options) => {
      const row = generation(String(options.snapshotId));
      primary.generations.set(row.generationId, row);
      primary.pointer = row.generationId;
      return {
        snapshotId: row.generationId,
        asOfDate: row.asOfDate,
        freshness: {},
        generatedAt: row.generatedAt,
        currentCoveragePct: 100,
        historyExactCoveragePct: 100,
        historyUsableCoveragePct: 100,
      };
    });

    const first = await reconcileOverviewPublication(env, new Date("2026-07-21T21:00:00.000Z"));
    const second = await reconcileOverviewPublication(env, new Date("2026-07-21T21:05:00.000Z"));

    expect(first.status).toBe("published");
    expect(second.status).toBe("published");
    expect(first.generationId).toBe(second.generationId);
    expect(recoveryMocks.compute).toHaveBeenCalledTimes(1);
    expect(recoveryMocks.compute.mock.calls[0]?.[3]).toMatchObject({
      includeBreadth: false,
      sourceCycleId: "cycle-1",
    });
  });

  it("records a transient publisher failure as retrying and succeeds on the next tick", async () => {
    const primary = new PrimaryDb();
    const env = createEnv(primary);
    recoveryMocks.compute
      .mockRejectedValueOnce(new Error("temporary D1 failure"))
      .mockImplementationOnce(async (_env, _date, _configId, options) => {
        const row = generation(String(options.snapshotId));
        primary.generations.set(row.generationId, row);
        primary.pointer = row.generationId;
        return {};
      });

    const failed = await reconcileOverviewPublication(env, new Date("2026-07-21T21:00:00.000Z"));
    const recovered = await reconcileOverviewPublication(env, new Date("2026-07-21T21:05:00.000Z"));

    expect(failed.status).toBe("retrying");
    expect(failed.lastError).toContain("temporary D1 failure");
    expect(recovered.status).toBe("published");
    expect(recoveryMocks.compute).toHaveBeenCalledTimes(2);
  });

  it("deduplicates a stale SLA alert and records one recovery event", async () => {
    const primary = new PrimaryDb();
    const pointed = generation("generation-old");
    pointed.asOfDate = "2026-07-17";
    primary.generations.set(pointed.generationId, pointed);
    primary.pointer = pointed.generationId;
    const env = createEnv(primary);
    const staleState = {
      expectedAsOfDate: "2026-07-21",
      status: "refreshing_current",
      sourceCycleId: "cycle-1",
      processedTickers: 160,
      requestedTickers: 225,
      freshTickers: 157,
      unavailableTickers: 3,
      historyCoveragePct: null,
      publicationCoveragePct: null,
      generationId: null,
      lastAttemptAt: "2026-07-21T20:30:00.000Z",
      nextAttemptAt: null,
      lastErrorCode: null,
      lastError: null,
      publishedAt: null,
      servingState: "stale_fallback",
      staleTradingSessions: 2,
    } as const;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await auditOverviewFreshnessState(env, new Date("2026-07-21T21:00:00.000Z"), staleState);
      await auditOverviewFreshnessState(env, new Date("2026-07-21T21:05:00.000Z"), staleState);
      expect(primary.scheduledAuditWrites).toBe(1);

      await auditOverviewFreshnessState(env, new Date("2026-07-21T21:07:00.000Z"), {
        ...staleState,
        staleTradingSessions: 1,
      });
      expect(primary.scheduledAuditWrites).toBe(1);

      await auditOverviewFreshnessState(env, new Date("2026-07-21T21:10:00.000Z"), {
        ...staleState,
        servingState: "ready",
        staleTradingSessions: 0,
        status: "published",
      });
      expect(primary.scheduledAuditWrites).toBe(2);
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(infoSpy).toHaveBeenCalledOnce();
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});
