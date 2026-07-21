import { describe, expect, it, vi } from "vitest";
import { claimNextRefreshJob, isRefreshJobClaimable, refreshJobIdempotencyKey } from "../src/refresh-jobs-service";
import type { Env } from "../src/types";

describe("refresh job leasing", () => {
  it("deduplicates requests within a five-minute bucket", () => {
    const first = refreshJobIdempotencyKey("overview", null, new Date("2026-07-21T01:01:00Z"));
    const second = refreshJobIdempotencyKey("overview", null, new Date("2026-07-21T01:04:59Z"));
    expect(first).toBe(second);
  });

  it("recovers a running job only after its lease expires", () => {
    const now = new Date("2026-07-21T01:05:00Z");
    expect(isRefreshJobClaimable("running", null, "2026-07-21T01:04:59Z", now)).toBe(true);
    expect(isRefreshJobClaimable("running", null, "2026-07-21T01:05:01Z", now)).toBe(false);
  });

  it("makes expired max-attempt leases terminal before claiming more work", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            statements.push({ sql, args });
            return {
              run,
              async first<T>() {
                return null as T;
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await claimNextRefreshJob({ DB: db } as Env, new Date("2026-07-21T01:05:00Z"));

    expect(statements[0]?.sql).toContain("attempt_count >= ?");
    expect(statements[0]?.args.at(-1)).toBe(3);
    expect(statements[1]?.sql).toContain("attempt_count < ?");
    expect(statements[1]?.args.at(-1)).toBe(3);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
