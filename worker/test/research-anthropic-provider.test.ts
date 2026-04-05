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

  it("falls through to a fallback model when Anthropic returns model not found", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: "error",
        error: {
          type: "not_found_error",
          message: "model: missing-primary-model",
        },
      }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: [
          {
            text: "{\"summary\":\"Recovered via fallback model.\"}",
          },
        ],
        usage: { input_tokens: 8, output_tokens: 12 },
        model: "claude-sonnet",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("scheduler", { wait: vi.fn().mockResolvedValue(undefined) });

    const response = await callAnthropicJson<{ summary: string }>(buildEnv(), {
      model: "missing-primary-model",
      fallbackModels: ["claude-sonnet"],
      system: "Return strict JSON only.",
      user: "{}",
      maxAttemptsPerModel: 1,
    });

    expect(response.data).toEqual({ summary: "Recovered via fallback model." });
    expect(response.model).toBe("claude-sonnet");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).model).toBe("claude-sonnet");
  });

  it("retries a timed out Anthropic request before succeeding", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("Anthropic request for claude-test timed out after 25000ms."))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: [
          {
            text: "{\"summary\":\"Recovered after retry.\"}",
          },
        ],
        usage: { input_tokens: 9, output_tokens: 13 },
        model: "claude-test",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    const waitMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("scheduler", { wait: waitMock });

    const response = await callAnthropicJson<{ summary: string }>(buildEnv(), {
      model: "claude-test",
      system: "Return strict JSON only.",
      user: "{}",
      requestTimeoutMs: 25_000,
      maxAttemptsPerModel: 2,
    });

    expect(response.data).toEqual({ summary: "Recovered after retry." });
    expect(response.model).toBe("claude-test");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(waitMock).toHaveBeenCalledTimes(1);
  });

  it("emits heartbeat callbacks before each long provider segment", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: [
          {
            text: "{\"summary\":\"missing end quote}",
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
            text: "{\"summary\":\"Recovered by repair.\"}",
          },
        ],
        usage: { input_tokens: 11, output_tokens: 16 },
        model: "claude-repair",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    const onHeartbeat = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    const response = await callAnthropicJson<{ summary: string }>(buildEnv(), {
      model: "claude-test",
      system: "Return strict JSON only.",
      user: "{}",
      onHeartbeat,
    });

    expect(response.data).toEqual({ summary: "Recovered by repair." });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onHeartbeat).toHaveBeenCalledTimes(2);
  });
});

describe("Anthropic model selection", () => {
  it("keeps extraction on haiku but prepares a sonnet fallback", () => {
    const selection = buildAnthropicExtractionModels(buildEnv(), "claude-3-haiku-20240307");
    expect(selection.model).toBe("claude-3-haiku-20240307");
    expect(selection.fallbackModels).toContain("claude-3-5-haiku-20241022");
    expect(selection.fallbackModels).toContain("claude-sonnet-4-6");
  });

  it("upgrades sonnet stages away from stale haiku prompt models", () => {
    const selection = buildAnthropicSonnetModels(buildEnv(), "claude-3-haiku-20240307");
    expect(selection.model).toBe("claude-sonnet-4-6");
    expect(selection.fallbackModels).not.toContain("claude-sonnet-4-6");
    expect(selection.fallbackModels).toContain("claude-3-5-sonnet-20241022");
  });
});
