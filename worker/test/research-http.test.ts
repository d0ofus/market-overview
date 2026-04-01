import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTextWithTimeout } from "../src/research/providers/http";

describe("fetchTextWithTimeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("times out while the response body is still streaming", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async (_input, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return {
        ok: true,
        status: 200,
        text: () => new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        }),
      } satisfies Partial<Response>;
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchTextWithTimeout("https://example.com", {}, 1_000, "Perplexity search for BE");
    const assertion = expect(promise).rejects.toThrow("Perplexity search for BE timed out after 1000ms.");
    await vi.advanceTimersByTimeAsync(1_100);
    await assertion;
  });
});
