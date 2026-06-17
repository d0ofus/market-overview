import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

function createEnv(extra?: Partial<Env>): Env {
  return {
    ADMIN_SECRET: "secret",
    DB: {
      prepare() {
        throw new Error("DB should not be reached for unauthorized refresh");
      },
    } as unknown as D1Database,
    ...extra,
  } as Env;
}

describe("FOMC commentary API", () => {
  it("requires admin auth for manual refresh", async () => {
    const response = await worker.fetch(new Request("https://example.com/api/fomc-commentary/refresh", { method: "POST" }), createEnv(), {} as ExecutionContext);
    expect(response.status).toBe(401);
  });

  it("validates eventType before refresh", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/api/fomc-commentary/refresh", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: JSON.stringify({ eventType: "speech" }),
      }),
      createEnv(),
      {} as ExecutionContext,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "eventType must be press_conference or minutes." });
  });
});
