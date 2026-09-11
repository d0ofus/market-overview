import { describe, expect, it, vi } from "vitest";
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
  it("returns an empty stored cache without provider requests or writes, including force query parameters",async()=>{
    const queries:string[]=[];
    const db={prepare(sql:string){queries.push(sql);return{bind(){return this;},all:async()=>({results:[]})};}} as unknown as D1Database;
    const provider=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Public reads must not refresh providers"));
    try {
      const response=await worker.fetch(new Request("https://example.com/api/fomc-commentary?force=1"),createEnv({DB:db}),{} as ExecutionContext);
      expect(response.status).toBe(200);expect(await response.json()).toEqual({items:[]});
      expect(queries).toHaveLength(1);expect(queries[0]).toMatch(/^\s*SELECT/);
      expect(provider).not.toHaveBeenCalled();
    } finally {provider.mockRestore();}
  });
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
