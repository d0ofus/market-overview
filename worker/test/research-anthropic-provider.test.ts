import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { callAnthropicJson } from "../src/research/providers/anthropic";

function buildEnv(): Env {
  return {
    ANTHROPIC_API_KEY: "test-key",
  } as Env;
}

describe("callAnthropicJson", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("parses fenced JSON arrays from Anthropic content blocks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [
        {
          text: "```json\n[{\"ticker\":\"NVMI\",\"rank\":1}]\n```",
        },
      ],
      usage: { input_tokens: 12, output_tokens: 24 },
      model: "claude-test",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await callAnthropicJson<Array<{ ticker: string; rank: number }>>(buildEnv(), {
      model: "claude-test",
      system: "Return strict JSON only.",
      user: "{}",
    });

    expect(response.data).toEqual([{ ticker: "NVMI", rank: 1 }]);
    expect(response.model).toBe("claude-test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries when Anthropic returns malformed JSON before succeeding", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: [
          {
            text: "{\"watchItems\":[\"earnings date\" \"margin update\"],\"summary\":\"Still constructive.\"}",
          },
        ],
        usage: { input_tokens: 10, output_tokens: 15 },
        model: "claude-test",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: [
          {
            text: "{\"watchItems\":[\"earnings date\",\"margin update\"],\"summary\":\"Still constructive.\"}",
          },
        ],
        usage: { input_tokens: 11, output_tokens: 16 },
        model: "claude-test",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    const waitMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("scheduler", { wait: waitMock });

    const response = await callAnthropicJson<{ watchItems: string[]; summary: string }>(buildEnv(), {
      model: "claude-test",
      system: "Return strict JSON only.",
      user: "{}",
    });

    expect(response.data).toEqual({
      watchItems: ["earnings date", "margin update"],
      summary: "Still constructive.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(waitMock).toHaveBeenCalledTimes(1);
  });
});
