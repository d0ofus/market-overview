import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { approveUniverseVersion, computeUniverseMembershipHash, stageAndPromoteUniverseVersion, validateUniverseCandidate } from "../src/universe-version-service";

function tickers(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

describe("universe candidate validation", () => {
  it("rejects an implausibly small Russell proxy", () => {
    const result = validateUniverseCandidate({
      universeId: "russell2000-core",
      tickers: tickers("R", 24),
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("1800-2100");
  });

  it("rejects a large S&P membership change unless explicitly approved", () => {
    const previous = tickers("OLD", 500);
    const candidate = [...previous.slice(0, 450), ...tickers("NEW", 50)];
    expect(validateUniverseCandidate({
      universeId: "sp500-core",
      tickers: candidate,
      previousTickers: previous,
    }).valid).toBe(false);
    expect(validateUniverseCandidate({
      universeId: "sp500-core",
      tickers: candidate,
      previousTickers: previous,
      approveLargeChange: true,
    }).valid).toBe(true);
  });

  it("allows a valid Russell candidate to replace the known-invalid 24-member legacy set", () => {
    const result = validateUniverseCandidate({
      universeId: "russell2000-core",
      tickers: tickers("R", 1_935),
      sourceMemberCount: 1_963,
      previousTickers: tickers("OLD", 24),
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a Russell candidate whose symbol-resolution coverage is below 95%", () => {
    const result = validateUniverseCandidate({
      universeId: "russell2000-core",
      tickers: tickers("R", 1_800),
      sourceMemberCount: 2_000,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("resolution coverage");
  });

  it("rejects a resolved Russell membership below the absolute minimum even at 95% coverage", () => {
    const result = validateUniverseCandidate({
      universeId: "russell2000-core",
      tickers: tickers("R", 1_710),
      sourceMemberCount: 1_800,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("resolved member count");
  });

  it("hashes normalized membership independently of order and duplicates", async () => {
    expect(await computeUniverseMembershipHash(["msft", "AAPL", "AAPL"]))
      .toBe(await computeUniverseMembershipHash(["AAPL", "MSFT"]));
  });

  it("does not let manual approval bypass stored source-resolution coverage", async () => {
    const members = tickers("R", 1_800);
    const db = {
      prepare: (sql: string) => {
        const statement = {
          bind: () => statement,
          first: async () => ({
            id: "rejected-v1",
            universeId: "russell2000-core",
            status: "rejected",
            sourceMemberCount: 2_000,
            sourceAsOfDate: new Date().toISOString().slice(0, 10),
          }),
          all: async () => ({ results: members.map((ticker) => ({ ticker })) }),
        };
        return statement;
      },
      batch: vi.fn(),
    };
    await expect(approveUniverseVersion({ DB: db } as any, "rejected-v1"))
      .rejects.toThrow(/resolution coverage/i);
  });

  it("rejects manual approval when stored Russell source provenance is stale", async () => {
    const statement = {
      bind: () => statement,
      first: async () => ({
        id: "rejected-v1",
        universeId: "russell2000-core",
        status: "rejected",
        sourceMemberCount: 2_000,
        sourceAsOfDate: "2020-01-01",
      }),
      all: async () => ({ results: [] }),
    };
    await expect(approveUniverseVersion({ DB: { prepare: () => statement } } as any, "rejected-v1"))
      .rejects.toThrow(/source date is missing or stale/i);
  });

  it("updates provenance without creating version/member rows when membership is unchanged", async () => {
    const members = tickers("R", 1_953);
    const membershipHash = await computeUniverseMembershipHash(members);
    const executed: Array<{ sql: string; args: unknown[] }> = [];
    const batch = vi.fn(async () => []);
    const db = {
      prepare: (sql: string) => {
        let args: unknown[] = [];
        const statement = {
          bind: (...values: unknown[]) => {
            args = values;
            return statement;
          },
          all: async () => {
            if (sql.includes("FROM universes u") && sql.includes("universe_version_members")) {
              return { results: members.map((ticker) => ({ ticker })) };
            }
            throw new Error(`Unexpected all(): ${sql}`);
          },
          first: async () => {
            if (sql.includes("uv.membership_hash as membershipHash")) {
              return { id: "active-v1", membershipHash: null };
            }
            throw new Error(`Unexpected first(): ${sql}`);
          },
          run: async () => {
            executed.push({ sql, args });
            return { success: true };
          },
        };
        return statement;
      },
      batch,
    };

    const result = await stageAndPromoteUniverseVersion({ DB: db } as unknown as Env, {
      universeId: "russell2000-core",
      universeName: "Russell 2000 — IWM proxy",
      source: "iShares IWM holdings",
      sourceType: "official-etf-holdings-proxy",
      sourceUrl: "https://example.test/iwm.csv",
      sourceAsOfDate: "2026-07-29",
      sourceMemberCount: members.length,
      unresolvedCount: 0,
      unresolvedTickers: [],
      tickers: [...members].reverse(),
    });

    expect(result).toMatchObject({ versionId: "active-v1", unchanged: true });
    expect(batch).not.toHaveBeenCalled();
    expect(executed).toHaveLength(1);
    expect(executed[0].sql).toContain("UPDATE universe_versions");
    expect(executed[0].sql).not.toContain("INSERT");
    expect(executed[0].args).toContain("2026-07-29");
    expect(executed[0].args).toContain(membershipHash);
  });

  it("prunes stale rejected versions before surfacing candidate validation failure", async () => {
    const executed: Array<{ sql: string; args: unknown[] }> = [];
    const batched: Array<{ sql: string; args: unknown[] }> = [];
    let candidateId = "candidate";
    const db = {
      prepare: (sql: string) => {
        let args: unknown[] = [];
        const statement = {
          sql,
          get args() {
            return args;
          },
          bind: (...values: unknown[]) => {
            args = values;
            return statement;
          },
          first: async () => sql.includes("SELECT active_version_id")
            ? { activeVersionId: "active-old" }
            : null,
          all: async () => {
            if (sql.includes("FROM universes u")) return { results: [] };
            if (sql.includes("SELECT uv.id FROM universe_versions")) {
              return {
                results: [
                  { id: candidateId },
                  ...Array.from({ length: 6 }, (_, index) => ({ id: `old-${index}` })),
                  { id: "active-old" },
                ],
              };
            }
            return { results: [] };
          },
          run: async () => {
            if (sql.includes("INSERT INTO universe_versions")) candidateId = String(args[0]);
            executed.push({ sql, args });
            return { success: true };
          },
        };
        return statement;
      },
      batch: vi.fn(async (statements: Array<{ sql: string; args: unknown[] }>) => {
        batched.push(...statements.map((statement) => ({ sql: statement.sql, args: statement.args })));
        return [];
      }),
    };

    await expect(stageAndPromoteUniverseVersion({ DB: db } as unknown as Env, {
      universeId: "russell2000-core",
      universeName: "Russell 2000 — IWM proxy",
      source: "iShares IWM holdings",
      tickers: tickers("R", 24),
    })).rejects.toThrow(/rejected .* candidate/i);

    expect(executed.some((entry) => entry.sql.includes("status = 'rejected'"))).toBe(true);
    expect(batched.filter((entry) => entry.sql.includes("DELETE FROM universe_version_members"))).toHaveLength(3);
    expect(batched.filter((entry) => entry.sql.includes("DELETE FROM universe_versions"))).toHaveLength(3);
    expect(batched.flatMap((entry) => entry.args)).not.toContain("active-old");
  });
});
