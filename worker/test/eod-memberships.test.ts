import { describe, expect, it } from "vitest";
import { loadEodMemberships } from "../src/eod";
import { eodHash } from "../src/eod-publication-service";
import { encodeEodPayload, type EodStoredPayload } from "../src/eod-publication-codec";
import type { Env } from "../src/types";

function environment(input: { historical?: boolean; sourceDate?: string; verifiedAt?: string; count?: number; proof?: unknown; checksum?: string; encoded?: EodStoredPayload } = {}) {
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind: (...values: unknown[]) => { args = values; return statement; },
        all: async () => {
          queries.push({ sql, args });
          if (sql.includes("WITH eligible_versions")) return {
            results: Array.from({ length: input.count ?? 500 }, (_, index) => ({
              universeId: "sp500-core", versionId: input.historical ? "past-version" : "active-version",
              activeVersionId: "active-version", source: "immutable old source",
              sourceType: "old-source-type", sourceUrl: "https://example.test/old",
              sourceAsOfDate: "2026-08-28", ticker: `T${index}`,
            })),
          };
          if (sql.includes("FROM universe_source_sync_state")) return { results: [{
            sourceKey: "universe:sp500-core", source: "recent successful verification",
            sourceType: "public-index-constituents-proxy", sourceUrl: "https://example.test/new",
            sourceAsOfDate: input.sourceDate ?? "2026-09-08", verifiedAt: input.verifiedAt ?? "2026-09-08T21:00:00Z",
          }] };
          if (sql.includes("FROM eod_publications")) return {results:input.proof ? [{payload:JSON.stringify(input.proof),...input.encoded,payloadChecksum:input.checksum}] : []};
          throw new Error(`Unexpected query: ${sql}`);
        },
      };
      return statement;
    },
  };
  return { env: { DB: db, MARKET_DATA_DB: db, OPS_DB: db } as unknown as Env, queries };
}

describe("immutable EOD membership inputs", () => {
  it("uses fresh verification for unchanged active membership without rewriting its version", async () => {
    const { env, queries } = environment();
    const rows = await loadEodMemberships(env, "2026-09-08");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ versionId: "active-version", source: "recent successful verification",
      sourceAsOfDate: null, verifiedAt: "2026-09-08T21:00:00Z" });
    expect(rows[0]!.members).toHaveLength(500);
    expect(queries[0]!.sql).toContain("v.status IN ('active', 'superseded')");
    expect(queries[0]!.sql).toContain("datetime(COALESCE(v.promoted_at, v.created_at)) < datetime(?)");
    expect(queries[0]!.sql).toContain("AND v.universe_id IN (SELECT value FROM json_each(?))");
    expect(queries[0]!.sql.trimEnd()).toMatch(/\/\* eod-membership-input-read \*\/$/);
    expect(queries[0]!.args.slice(0,3)).toEqual(["2026-09-08","2026-09-09T04:00:00.000Z","2026-09-08"]);
  });

  it("keeps today's successful verification when the unchanged source list is old and an older publication exists", async () => {
    const proof={membership:{versionId:"active-version",source:"yesterday's frozen verification",sourceAsOfDate:"2026-08-28",
      verifiedAt:"2026-09-04T21:00:00Z",sourceType:"public-index-constituents-proxy"}};
    const {env,queries}=environment({sourceDate:"2026-08-28",verifiedAt:"2026-09-08T21:00:00Z",proof,checksum:await eodHash(proof)});
    expect((await loadEodMemberships(env,"2026-09-08"))[0]).toMatchObject({
      source:"recent successful verification",sourceAsOfDate:null,verifiedAt:"2026-09-08T21:00:00Z",
    });
    expect(queries.some((query) => query.sql.includes("FROM eod_publications"))).toBe(false);
  });

  it("never replaces expired current evidence with an even older verification", async () => {
    const proof={membership:{versionId:"active-version",source:"older publication",sourceAsOfDate:"2026-08-28",
      verifiedAt:"2026-08-28T20:00:00Z",sourceType:"public-index-constituents-proxy"}};
    const {env,queries}=environment({sourceDate:"2026-08-28",verifiedAt:"2026-08-28T21:00:00Z",proof,checksum:await eodHash(proof)});
    expect((await loadEodMemberships(env,"2026-09-08"))[0]).toMatchObject({
      source:"recent successful verification",verifiedAt:"2026-08-28T21:00:00Z",
    });
    expect(queries.some((query) => query.sql.includes("FROM eod_publications"))).toBe(true);
  });

  it("rejects an invalid verification timestamp even when its publication checksum is valid", async () => {
    const proof={membership:{versionId:"past-version",source:"invalid time",sourceAsOfDate:"2026-09-04",
      verifiedAt:"2026-09-00T21:00:00Z",sourceType:"public-index-constituents-proxy"}};
    const {env}=environment({historical:true,proof,checksum:await eodHash(proof)});
    expect((await loadEodMemberships(env,"2026-09-08"))[0]).toMatchObject({
      source:"immutable old source",sourceAsOfDate:"2026-08-28",verifiedAt:null,
    });
  });

  it("does not borrow today's verification for a historical membership version", async () => {
    const { env } = environment({ historical: true });
    const [row] = await loadEodMemberships(env, "2026-09-08");
    expect(row).toMatchObject({ versionId: "past-version", source: "immutable old source",
      sourceAsOfDate: "2026-08-28", verifiedAt: null });
  });

  it("does not attach future verification to a historical session even when membership is unchanged", async () => {
    const { env } = environment({ verifiedAt: "2026-09-09T21:00:00Z" });
    expect((await loadEodMemberships(env, "2026-09-08"))[0]).toMatchObject({
      source: "immutable old source", sourceAsOfDate: "2026-08-28", verifiedAt: null,
    });
  });

  it("rejects malformed stored memberships before they reach aggregate coverage gates", async () => {
    const { env } = environment({ count: 24 });
    expect(await loadEodMemberships(env, "2026-09-08")).toEqual([]);
  });

  it.each(["2026-09-09T00:15:00Z", "2026-09-09 00:15:00"])("retains matching verification after UTC midnight on the same NY day (%s)", async (verifiedAt) => {
    const { env } = environment({ verifiedAt });
    expect((await loadEodMemberships(env, "2026-09-08"))[0]).toMatchObject({
      source: "recent successful verification", sourceAsOfDate: null, verifiedAt,
    });
  });

  it("does not relabel later-date source contents merely because verification is on the target NY evening", async () => {
    const { env } = environment({ sourceDate: "2026-09-09", verifiedAt: "2026-09-09T00:15:00Z" });
    expect((await loadEodMemberships(env, "2026-09-08"))[0]).toMatchObject({ source: "immutable old source", verifiedAt: null });
  });

  it("fails closed when a retained population exceeds the query's declared maximum", async () => {
    const { env, queries } = environment({ count: 8_001 });
    await expect(loadEodMemberships(env, "2026-09-08")).rejects.toThrow("eod-membership-population-exceeds-bound");
    expect(queries).toHaveLength(1);
  });

  it("recovers historical verification only from checksum-verified publications with identical immutable members", async () => {
    const proof={membership:{versionId:"past-version",source:"verified historical source",sourceAsOfDate:"2026-09-04",
      sourceType:"public-index-constituents-proxy",members:Array.from({length:500},(_,index)=>`T${index}`)}};
    const {env}=environment({historical:true,proof,checksum:await eodHash(proof)});
    expect((await loadEodMemberships(env,"2026-09-08"))[0]).toMatchObject({source:"verified historical source",sourceAsOfDate:null});
    const changed={membership:{...proof.membership,members:[...proof.membership.members.slice(1),"TODAYS_NEW_MEMBER"]}};
    const wrong=environment({historical:true,proof:changed,checksum:await eodHash(changed)});
    expect((await loadEodMemberships(wrong.env,"2026-09-08"))[0]?.source).toBe("immutable old source");
    const corrupt=environment({historical:true,proof,checksum:"incorrect"});
    expect((await loadEodMemberships(corrupt.env,"2026-09-08"))[0]?.source).toBe("immutable old source");
  });

  it("rehydrates compressed historical verification while taking constituents from the immutable version", async () => {
    const proof={membership:{versionId:"past-version",source:"verified historical source",sourceAsOfDate:"2026-09-04",
      sourceType:"public-index-constituents-proxy"}};
    const encoded={payload:"{}",...await encodeEodPayload(proof)};
    const {env}=environment({historical:true,proof,checksum:await eodHash(proof),encoded});
    const [membership]=await loadEodMemberships(env,"2026-09-08");
    expect(membership).toMatchObject({source:"verified historical source",sourceAsOfDate:null});
    expect(membership?.members).toHaveLength(500);
    expect(membership?.members[0]).toBe("T0");
  });
});
