import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import {
  buildAnthropicExtractionModels,
  buildAnthropicSonnetModels,
  callAnthropicJson,
} from "../src/research/providers/anthropic";

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

  it("repairs malformed Anthropic JSON before succeeding", async () => {
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
    expect(waitMock).toHaveBeenCalledTimes(0);
  });

  it("falls back to a secondary model when malformed JSON cannot be repaired", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: [
          {
            text: "{\"watchItems\":[\"earnings date\",\"margin update\"],\"summary\":\"Still constructive",
          },
        ],
        usage: { input_tokens: 10, output_tokens: 15 },
        model: "claude-haiku",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("repair failed", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: [
          {
            text: "{\"watchItems\":[\"earnings date\",\"margin update\"],\"summary\":\"Still constructive",
          },
        ],
        usage: { input_tokens: 10, output_tokens: 15 },
        model: "claude-haiku",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("repair failed", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: [
          {
            text: "{\"watchItems\":[\"earnings date\",\"margin update\"],\"summary\":\"Still constructive.\"}",
          },
        ],
        usage: { input_tokens: 11, output_tokens: 16 },
        model: "claude-sonnet",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("scheduler", { wait: vi.fn().mockResolvedValue(undefined) });

    const response = await callAnthropicJson<{ watchItems: string[]; summary: string }>(buildEnv(), {
      model: "claude-haiku",
      fallbackModels: ["claude-sonnet"],
      system: "Return strict JSON only.",
      user: "{}",
    });

    expect(response.data).toEqual({
      watchItems: ["earnings date", "margin update"],
      summary: "Still constructive.",
    });
    expect(response.model).toBe("claude-sonnet");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body)).model).toBe("claude-sonnet");
  });
});

describe("Anthropic model selection", () => {
  it("keeps extraction on haiku but prepares a sonnet fallback", () => {
    const selection = buildAnthropicExtractionModels(buildEnv(), "claude-3-haiku-20240307");
    expect(selection.model).toBe("claude-3-haiku-20240307");
    expect(selection.fallbackModels).toContain("claude-3-5-sonnet-20241022");
  });

  it("upgrades sonnet stages away from stale haiku prompt models", () => {
    const selection = buildAnthropicSonnetModels(buildEnv(), "claude-3-haiku-20240307");
    expect(selection.model).toBe("claude-3-5-sonnet-20241022");
    expect(selection.fallbackModels).not.toContain("claude-3-5-sonnet-20241022");
  });
});
