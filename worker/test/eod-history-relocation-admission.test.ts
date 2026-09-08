import { describe, expect, it } from "vitest";
import { estimateEodQueries } from "../src/eod-d1-rest";

describe("bounded relocation admission", () => {
  it("fits all three atomic statements in one credit envelope including trigger/index allowance", () => {
    const params = ["operation-id", JSON.stringify(Array.from({length: 40}, (_, index) => `2025-01-${index}`))];
    const queries = ["register", "delete", "cleanup"].map((stage) => ({
      sql: `DELETE FROM example WHERE value IN (SELECT value FROM json_each(?)) /* eod-history-relocation-${stage} */`, params,
    }));
    expect(estimateEodQueries(queries)).toEqual({ reads: 912, writes: 504 });
  });
  it("refuses oversized or malformed relocation inputs before SQL admission", () => {
    for (const value of ["not-json", JSON.stringify(Array.from({length: 41}, () => "date")), "{}"] ) {
      expect(() => estimateEodQueries([{ sql: "INSERT INTO example SELECT value FROM json_each(?) /* eod-history-relocation-register */",
        params: ["operation-id", value] }])).toThrow(/relocation-invalid-batch/);
    }
  });
  it("reserves the full compact catalog traversal, even when callers request a small subset", () => {
    expect(estimateEodQueries([{ sql: "WITH publication AS MATERIALIZED (SELECT 1) SELECT * FROM publication /* eod-history-catalog-read */",
      params: ["2026-09-04", '["AAA"]'] }])).toEqual({ reads: 50_000, writes: 0 });
  });
});
