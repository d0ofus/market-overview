import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

const fedwatchMocks = vi.hoisted(() => ({
  getFedWatchSnapshot: vi.fn(),
}));

vi.mock("../src/fedwatch-service", () => fedwatchMocks);

const worker = (await import("../src/index")).default;

function env(values: Partial<Env> = {}): Env {
  return values as Env;
}

function context(): ExecutionContext {
  return {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

describe("FedWatch API route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fedwatchMocks.getFedWatchSnapshot.mockResolvedValue({
      status: "ok",
      meetings: [],
    });
  });

  it("loads the public cached snapshot without forcing refresh", async () => {
    const request = new Request("https://example.com/api/fedwatch");
    const response = await worker.fetch(request, env(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(fedwatchMocks.getFedWatchSnapshot).toHaveBeenCalledWith(expect.any(Object), { force: false });
  });

  it("does not force refresh for public force=1 requests without admin auth", async () => {
    const request = new Request("https://example.com/api/fedwatch?force=1");
    await worker.fetch(request, env(), context());

    expect(fedwatchMocks.getFedWatchSnapshot).toHaveBeenCalledWith(expect.any(Object), { force: false });
  });

  it("allows force refresh when force=1 request is admin authenticated", async () => {
    const request = new Request("https://example.com/api/fedwatch?force=1", {
      headers: { authorization: "Bearer secret" },
    });
    await worker.fetch(request, env({ ADMIN_SECRET: "secret" }), context());

    expect(fedwatchMocks.getFedWatchSnapshot).toHaveBeenCalledWith(expect.any(Object), { force: true });
  });
});
