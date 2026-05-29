import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

const env = { ADMIN_SECRET: "secret" } as unknown as Env;

async function fetchWorker(path: string, init: RequestInit = {}) {
  return (worker as { fetch: typeof fetch }).fetch(new Request(`http://localhost${path}`, init), env as never);
}

describe("research lab auth", () => {
  it("requires admin auth for paid research lab mutations", async () => {
    const cases: Array<{ path: string; init: RequestInit }> = [
      {
        path: "/api/research-lab/runs",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tickers: ["AAPL"] }),
        },
      },
      { path: "/api/research-lab/runs/run-1/cancel", init: { method: "POST" } },
      { path: "/api/research-lab/runs/run-1/pump", init: { method: "POST" } },
    ];

    for (const item of cases) {
      const response = await fetchWorker(item.path, item.init);
      const body = await response.json() as { error: string };

      expect(response.status).toBe(401);
      expect(body.error).toBe("Unauthorized");
    }
  });

  it("rejects invalid admin auth on run creation", async () => {
    const response = await fetchWorker("/api/research-lab/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ tickers: ["AAPL"] }),
    });
    const body = await response.json() as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });
});
