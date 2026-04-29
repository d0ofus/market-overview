import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTickerFundamentals, parseSecCompanyFundamentals, refreshTickerFundamentals } from "../src/fundamentals-service";

const issuer = {
  ticker: "TEST",
  cik: "0000000001",
  companyName: "Test Company",
};

function usdFact(def: {
  val: number;
  start: string;
  end: string;
  fy: number;
  fp: string;
  form: string;
  filed: string;
  accn: string;
}) {
  return def;
}

function factsFor(units: unknown[]) {
  return { units: { USD: units } };
}

function makeCompanyFacts() {
  return {
    facts: {
      "us-gaap": {
        RevenueFromContractWithCustomerExcludingAssessedTax: factsFor([
          usdFact({ val: 100, start: "2024-01-01", end: "2024-03-31", fy: 2024, fp: "Q1", form: "10-Q", filed: "2024-05-01", accn: "rev-2024-q1" }),
          usdFact({ val: 110, start: "2024-04-01", end: "2024-06-30", fy: 2024, fp: "Q2", form: "10-Q", filed: "2024-08-01", accn: "rev-2024-q2" }),
          usdFact({ val: 120, start: "2024-07-01", end: "2024-09-30", fy: 2024, fp: "Q3", form: "10-Q", filed: "2024-11-01", accn: "rev-2024-q3" }),
          usdFact({ val: 460, start: "2024-01-01", end: "2024-12-31", fy: 2024, fp: "FY", form: "10-K", filed: "2025-02-15", accn: "rev-2024-fy" }),
          usdFact({ val: 150, start: "2025-01-01", end: "2025-03-31", fy: 2025, fp: "Q1", form: "10-Q", filed: "2025-05-01", accn: "rev-2025-q1" }),
          usdFact({ val: 160, start: "2025-04-01", end: "2025-06-30", fy: 2025, fp: "Q2", form: "10-Q", filed: "2025-07-20", accn: "rev-2025-q2-old" }),
          usdFact({ val: 165, start: "2025-04-01", end: "2025-06-30", fy: 2025, fp: "Q2", form: "10-Q", filed: "2025-08-01", accn: "rev-2025-q2-new" }),
          usdFact({ val: 180, start: "2025-07-01", end: "2025-09-30", fy: 2025, fp: "Q3", form: "10-Q", filed: "2025-11-01", accn: "rev-2025-q3" }),
          usdFact({ val: 700, start: "2025-01-01", end: "2025-12-31", fy: 2025, fp: "FY", form: "10-K", filed: "2026-02-15", accn: "rev-2025-fy" }),
        ]),
        ProfitLoss: factsFor([
          usdFact({ val: 10, start: "2024-01-01", end: "2024-03-31", fy: 2024, fp: "Q1", form: "10-Q", filed: "2024-05-01", accn: "ni-2024-q1" }),
          usdFact({ val: 11, start: "2024-04-01", end: "2024-06-30", fy: 2024, fp: "Q2", form: "10-Q", filed: "2024-08-01", accn: "ni-2024-q2" }),
          usdFact({ val: 12, start: "2024-07-01", end: "2024-09-30", fy: 2024, fp: "Q3", form: "10-Q", filed: "2024-11-01", accn: "ni-2024-q3" }),
          usdFact({ val: 46, start: "2024-01-01", end: "2024-12-31", fy: 2024, fp: "FY", form: "10-K", filed: "2025-02-15", accn: "ni-2024-fy" }),
          usdFact({ val: 15, start: "2025-01-01", end: "2025-03-31", fy: 2025, fp: "Q1", form: "10-Q", filed: "2025-05-01", accn: "ni-2025-q1" }),
          usdFact({ val: 18, start: "2025-04-01", end: "2025-06-30", fy: 2025, fp: "Q2", form: "10-Q", filed: "2025-08-01", accn: "ni-2025-q2" }),
          usdFact({ val: 21, start: "2025-07-01", end: "2025-09-30", fy: 2025, fp: "Q3", form: "10-Q", filed: "2025-11-01", accn: "ni-2025-q3" }),
          usdFact({ val: 80, start: "2025-01-01", end: "2025-12-31", fy: 2025, fp: "FY", form: "10-K", filed: "2026-02-15", accn: "ni-2025-fy" }),
        ]),
      },
    },
  };
}

function createReadableFundamentalsDb() {
  return {
    prepare(sql: string) {
      return {
        async first<T>() {
          if (sql.includes("sqlite_master")) return { count: 2 } as T;
          throw new Error(`Unhandled first query: ${sql}`);
        },
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("FROM fundamental_issuers")) {
                return {
                  ticker: args[0],
                  cik: "0000000001",
                  companyName: "Test Company",
                  status: "ok",
                  lastRefreshedAt: "2026-02-16T00:00:00.000Z",
                  lastError: null,
                } as T;
              }
              throw new Error(`Unhandled bound first query: ${sql}`);
            },
            async all<T>() {
              if (sql.includes("FROM fundamental_quarters")) {
                return {
                  results: [
                    {
                      ticker: args[0],
                      cik: "0000000001",
                      companyName: "Test Company",
                      fiscalYear: 2025,
                      fiscalQuarter: 2,
                      periodEnd: "2025-06-30",
                      filedAt: "2025-08-01",
                      form: "10-Q",
                      accession: "new",
                      currency: "USD",
                      revenue: 165,
                      netIncome: 18,
                      revenueYoY: 50,
                      revenueQoQ: 10,
                      netIncomeYoY: 63.6364,
                      netIncomeQoQ: 20,
                      revenueSourceTag: "RevenueFromContractWithCustomerExcludingAssessedTax",
                      netIncomeSourceTag: "ProfitLoss",
                      derivation: "direct",
                      warningsJson: "[]",
                    },
                    {
                      ticker: args[0],
                      cik: "0000000001",
                      companyName: "Test Company",
                      fiscalYear: 2025,
                      fiscalQuarter: 1,
                      periodEnd: "2025-03-31",
                      filedAt: "2025-05-01",
                      form: "10-Q",
                      accession: "old",
                      currency: "USD",
                      revenue: 150,
                      netIncome: 15,
                      revenueYoY: 50,
                      revenueQoQ: 15.3846,
                      netIncomeYoY: 50,
                      netIncomeQoQ: 15.3846,
                      revenueSourceTag: "RevenueFromContractWithCustomerExcludingAssessedTax",
                      netIncomeSourceTag: "ProfitLoss",
                      derivation: "direct",
                      warningsJson: "[\"checked\"]",
                    },
                  ],
                } as T;
              }
              throw new Error(`Unhandled all query: ${sql}`);
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fundamentals SEC parser", () => {
  it("normalizes quarters, derives Q4, uses fallback tags, and computes growth", () => {
    const parsed = parseSecCompanyFundamentals("test", issuer, makeCompanyFacts());
    const rows = parsed.rows;
    const q2 = rows.find((row) => row.fiscalYear === 2025 && row.fiscalQuarter === 2);
    const q4 = rows.find((row) => row.fiscalYear === 2025 && row.fiscalQuarter === 4);

    expect(parsed.completePeriodsFound).toBe(8);
    expect(parsed.derivedQ4Count).toBe(2);
    expect(q2?.revenue).toBe(165);
    expect(q2?.accession).toBe("rev-2025-q2-new");
    expect(q4).toMatchObject({
      ticker: "TEST",
      fiscalYear: 2025,
      fiscalQuarter: 4,
      revenue: 205,
      netIncome: 26,
      revenueSourceTag: "RevenueFromContractWithCustomerExcludingAssessedTax",
      netIncomeSourceTag: "ProfitLoss",
      derivation: "derived_q4_from_fy_minus_q1_q2_q3",
    });
    expect(q4?.revenueYoY).toBeCloseTo(57.6923, 4);
    expect(q4?.revenueQoQ).toBeCloseTo(13.8889, 4);
    expect(q4?.netIncomeYoY).toBeCloseTo(100, 4);
    expect(q4?.netIncomeQoQ).toBeCloseTo(23.8095, 4);
    expect(q4?.warnings.some((warning) => warning.includes("Q4 derived from annual FY less Q1-Q3"))).toBe(true);
  });

  it("reads cached D1 rows oldest-to-newest and decodes warnings", async () => {
    const payload = await loadTickerFundamentals(
      { DB: createReadableFundamentalsDb(), FUNDAMENTALS_DB: createReadableFundamentalsDb() } as never,
      "test",
      2,
    );

    expect(payload.schemaReady).toBe(true);
    expect(payload.issuer?.ticker).toBe("TEST");
    expect(payload.rows.map((row) => `${row.fiscalYear}Q${row.fiscalQuarter}`)).toEqual(["2025Q1", "2025Q2"]);
    expect(payload.rows[0]?.warnings).toEqual(["checked"]);
  });

  it("refreshes from SEC and prepares issuer plus quarter upserts", async () => {
    const batchedStatements: Array<{ sql: string; args: unknown[] }> = [];
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => {
        if (url.includes("company_tickers")) {
          return { "0": { cik_str: 1, ticker: "TEST", title: "Test Company" } };
        }
        return makeCompanyFacts();
      },
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const db = {
      prepare(sql: string) {
        return {
          sql,
          async first<T>() {
            if (sql.includes("sqlite_master")) return { count: 2 } as T;
            throw new Error(`Unhandled first query: ${sql}`);
          },
          bind(...args: unknown[]) {
            return {
              sql,
              args,
              async run() {
                return {};
              },
            };
          },
        };
      },
      async batch(statements: Array<{ sql: string; args: unknown[] }>) {
        batchedStatements.push(...statements);
        return [];
      },
    } as unknown as D1Database;

    const result = await refreshTickerFundamentals(
      { DB: db, FUNDAMENTALS_DB: db, SEC_USER_AGENT: "market-overview-test contact:test@example.com" } as never,
      "test",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.rowsUpserted).toBe(8);
    expect(result.derivedQ4Count).toBe(2);
    expect(batchedStatements).toHaveLength(9);
    expect(batchedStatements.some((statement) => statement.args.includes(205) && statement.args.includes(26))).toBe(true);
  });
});
