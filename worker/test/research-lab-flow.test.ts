import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const promptConfig = {
    id: "research-lab-prompt-default-v1",
    name: "Research Lab Prompt",
    description: null,
    configFamily: "research_lab_default",
    modelFamily: "claude-sonnet-4-6",
    systemPrompt: "Test prompt",
    schemaVersion: "v1",
    isDefault: true,
    synthesisConfigJson: {},
    createdAt: "2026-03-31T10:00:00.000Z",
    updatedAt: "2026-03-31T10:00:00.000Z",
  };

  const profile = {
    id: "research-lab-profile-default",
    slug: "default",
    name: "Default Research Lab",
    description: null,
    isActive: true,
    isDefault: true,
    currentVersionId: "research-lab-profile-default-v1",
    createdAt: "2026-03-31T10:00:00.000Z",
    updatedAt: "2026-03-31T10:00:00.000Z",
  };

  const profileVersion = {
    id: "research-lab-profile-default-v1",
    profileId: "research-lab-profile-default",
    versionNumber: 1,
    label: "Default",
    modelFamily: "claude-sonnet-4-6",
    systemPrompt: "Test prompt",
    schemaVersion: "v1",
    evidenceConfigJson: {},
    synthesisConfigJson: {},
    modulesConfigJson: {},
    isActive: true,
    createdAt: "2026-03-31T10:00:00.000Z",
  };

  const evidenceProfile = {
    id: "research-lab-evidence-default-v1",
    name: "Research Lab Evidence",
    description: null,
    configFamily: "research_lab_default",
    isDefault: true,
    queryConfigJson: {},
    createdAt: "2026-03-31T10:00:00.000Z",
    updatedAt: "2026-03-31T10:00:00.000Z",
  };

  function makeEvidence(runId: string, runItemId: string, ticker: string) {
    return [{
      id: `${ticker}-e1`,
      runId,
      runItemId,
      ticker,
      providerKey: "perplexity",
      evidenceKind: "news_catalysts",
      queryLabel: "News & Catalysts",
      canonicalUrl: `https://example.com/${ticker.toLowerCase()}`,
      sourceDomain: "example.com",
      title: `${ticker} reports positive demand`,
      publishedAt: "2026-03-31T09:00:00.000Z",
      summary: `${ticker} has positive demand and a fresh catalyst.`,
      excerpt: "Positive demand and a fresh catalyst were highlighted.",
      bullets: ["positive demand", "fresh catalyst"],
      contentHash: `${ticker}-hash`,
      providerPayloadJson: { provider: "perplexity" },
      createdAt: "2026-03-31T09:00:00.000Z",
    }];
  }

  function makeSynthesis(ticker: string, companyName = `${ticker} Corp`) {
    return {
      ticker,
      companyName,
      opinion: "positive",
      overallSummary: `${ticker} looks constructive on current evidence.`,
      whyNow: `${ticker} has fresh demand and catalyst support.`,
      valuationView: {
        label: "fair",
        summary: "Valuation looks fair relative to the current evidence set.",
      },
      earningsQualityView: {
        label: "strong",
        summary: "Recent evidence suggests clean execution and earnings quality.",
      },
      pricedInView: {
        label: "partially_priced_in",
        summary: "Some improvement appears priced in, but not the full upside.",
      },
      catalysts: [{
        title: "Fresh demand",
        summary: "Demand remains constructive.",
        direction: "positive",
        timeframe: "next quarter",
        evidenceIds: [`${ticker}-e1`],
      }],
      risks: [{
        title: "Execution slip",
        summary: "Execution still needs to hold up.",
        severity: "medium",
        evidenceIds: [`${ticker}-e1`],
      }],
      contradictions: [],
      confidence: {
        label: "medium",
        score: 0.68,
        summary: "Evidence quality is decent but not exhaustive.",
      },
      monitoringPoints: ["Watch next earnings commentary"],
      priorComparison: null,
      evidenceIds: [`${ticker}-e1`],
    };
  }

  function makePriorOutput(ticker: string) {
    return {
      id: `prior-${ticker}`,
      runId: "prior-run",
      runItemId: "prior-item",
      ticker,
      profileId: profile.id,
      profileVersionId: profileVersion.id,
      promptConfigId: promptConfig.id,
      evidenceProfileId: evidenceProfile.id,
      priorOutputId: null,
      synthesisJson: makeSynthesis(ticker, `${ticker} Old Corp`),
      memorySummaryJson: {
        opinion: "positive",
        overallSummary: `${ticker} prior summary`,
        pricedInLabel: "partially_priced_in",
        confidenceLabel: "medium",
        topCatalysts: ["Old catalyst"],
        topRisks: ["Old risk"],
        evidenceIds: [`${ticker}-old-e1`],
      },
      deltaJson: null,
      sourceEvidenceIds: [`${ticker}-old-e1`],
      model: "claude-sonnet-4-6",
      usageJson: { input_tokens: 100, output_tokens: 200 },
      createdAt: "2026-03-30T09:00:00.000Z",
    };
  }

  function createState() {
    return {
      run: null as any,
      items: [] as any[],
      events: [] as any[],
      evidence: [] as any[],
      outputs: [] as any[],
      memoryHeads: new Map<string, any>(),
      promptConfig,
      evidenceProfile,
      profile,
      profileVersion,
      watchlistSet: {
        id: "watchlist-set-1",
        scanDefinitionId: "scan-1",
        name: "Momentum Set",
        slug: "momentum-set",
        isActive: true,
        compileDaily: false,
        dailyCompileTimeLocal: null,
        dailyCompileTimezone: null,
        createdAt: "2026-03-31T10:00:00.000Z",
        updatedAt: "2026-03-31T10:00:00.000Z",
        sourceCount: 1,
        latestRun: null,
        sources: [],
      },
      watchlistCompiledRows: [
        { ticker: "KMI" },
        { ticker: "LASR" },
        { ticker: "KMI" },
      ],
      watchlistUniqueRows: [
        { ticker: "LASR" },
        { ticker: "KMI" },
        { ticker: "NVDA" },
      ],
      gatherError: null as Error | null,
      gatherDelayMs: 0,
      synthError: null as Error | null,
      priorOutputs: new Map<string, any>(),
      eventCounter: 0,
      outputCounter: 0,
      runCounter: 0,
      itemCounter: 0,
    };
  }

  return {
    state: createState(),
    createState,
    makeEvidence,
    makeSynthesis,
    makePriorOutput,
    reset() {
      this.state = createState();
    },
  };
});

vi.mock("../src/research/sec-normalization", () => ({
  normalizeResearchTicker: vi.fn(async (_env: unknown, ticker: string) => ({
    ticker,
    companyName: `${ticker} Corp`,
    exchange: "NYSE",
    secCik: `CIK-${ticker}`,
    irDomain: `${ticker.toLowerCase()}.com`,
  })),
}));

vi.mock("../src/research-lab/gather", () => ({
  gatherResearchLabEvidence: vi.fn(async (_env: unknown, input: { runId: string; runItemId: string; identity: { ticker: string } }) => {
    if (harness.state.gatherError) throw harness.state.gatherError;
    if (harness.state.gatherDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, harness.state.gatherDelayMs));
    }
    return {
      evidence: harness.makeEvidence(input.runId, input.runItemId, input.identity.ticker),
      usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
      model: "sonar-pro",
      promptEvidenceLimit: 12,
    };
  }),
}));

vi.mock("../src/research-lab/synthesize", () => ({
  synthesizeResearchLabOutput: vi.fn(async (_env: unknown, input: { identity: { ticker: string; companyName: string | null } }) => {
    if (harness.state.synthError) throw harness.state.synthError;
    return {
      synthesis: harness.makeSynthesis(input.identity.ticker, input.identity.companyName ?? `${input.identity.ticker} Corp`),
      usage: { input_tokens: 44, output_tokens: 55, total_tokens: 99 },
      model: "claude-sonnet-4-6",
    };
  }),
}));

vi.mock("../src/watchlist-compiler-service", () => ({
  loadWatchlistSet: vi.fn(async () => harness.state.watchlistSet),
  loadWatchlistCompiledRows: vi.fn(async () => ({
    set: harness.state.watchlistSet,
    runId: "watchlist-run-1",
    rows: harness.state.watchlistCompiledRows,
  })),
  loadWatchlistUniqueRows: vi.fn(async () => ({
    set: harness.state.watchlistSet,
    runId: "watchlist-run-1",
    rows: harness.state.watchlistUniqueRows,
  })),
}));

vi.mock("../src/research-lab/profiles", () => ({
  createResearchLabPromptConfigFromProfile: vi.fn((profile: any, version: any) => ({
    id: version.id,
    name: `${profile.name} (${version.label})`,
    description: profile.description,
    configFamily: `profile:${profile.id}`,
    modelFamily: version.modelFamily,
    systemPrompt: version.systemPrompt,
    schemaVersion: version.schemaVersion,
    isDefault: profile.isDefault,
    synthesisConfigJson: {
      ...(version.synthesisConfigJson ?? {}),
      modules: version.modulesConfigJson ?? {},
    },
    profileId: profile.id,
    profileVersionId: version.id,
    createdAt: version.createdAt,
    updatedAt: profile.updatedAt,
  })),
  createResearchLabEvidenceProfileFromProfile: vi.fn((profile: any, version: any) => ({
    id: version.id,
    name: `${profile.name} Evidence (${version.label})`,
    description: profile.description,
    configFamily: `profile:${profile.id}`,
    isDefault: profile.isDefault,
    queryConfigJson: version.evidenceConfigJson ?? {},
    createdAt: version.createdAt,
    updatedAt: profile.updatedAt,
  })),
  loadResearchLabProfile: vi.fn(async () => harness.state.profile),
  loadResearchLabProfileVersion: vi.fn(async () => harness.state.profileVersion),
  resolveResearchLabProfile: vi.fn(async () => ({
    profile: harness.state.profile,
    version: harness.state.profileVersion,
    promptConfig: {
      ...harness.state.promptConfig,
      profileId: harness.state.profile.id,
      profileVersionId: harness.state.profileVersion.id,
    },
    evidenceProfile: harness.state.evidenceProfile,
  })),
  resolveResearchLabProfileAtVersion: vi.fn(async () => ({
    profile: harness.state.profile,
    version: harness.state.profileVersion,
    promptConfig: {
      ...harness.state.promptConfig,
      profileId: harness.state.profile.id,
      profileVersionId: harness.state.profileVersion.id,
    },
    evidenceProfile: harness.state.evidenceProfile,
  })),
}));

vi.mock("../src/research-lab/storage", () => ({
  createResearchLabRun: vi.fn(async (_env: unknown, input: any) => {
    harness.state.runCounter += 1;
    const runId = `run-${harness.state.runCounter}`;
    harness.state.run = {
      id: runId,
      sourceType: input.sourceType ?? "manual",
      sourceId: input.sourceId ?? null,
      sourceLabel: input.sourceLabel ?? "Research Lab",
      profileId: input.profileId ?? null,
      profileVersionId: input.profileVersionId ?? null,
      promptConfigId: input.promptConfigId,
      evidenceProfileId: input.evidenceProfileId,
      status: "queued",
      requestedTickerCount: input.tickers.length,
      completedTickerCount: 0,
      failedTickerCount: 0,
      inputJson: input.request,
      providerUsageJson: null,
      metadataJson: input.metadataJson ?? null,
      errorSummary: null,
      startedAt: null,
      completedAt: null,
      heartbeatAt: "2026-03-31T10:00:00.000Z",
      createdAt: "2026-03-31T10:00:00.000Z",
      updatedAt: "2026-03-31T10:00:00.000Z",
    };
    harness.state.items = input.tickers.map((ticker: string, index: number) => {
      harness.state.itemCounter += 1;
      return {
        id: `item-${harness.state.itemCounter}`,
        runId,
        ticker,
        sortOrder: index + 1,
        companyName: null,
        exchange: null,
        secCik: null,
        irDomain: null,
        status: "queued",
        lastError: null,
        memoryOutputId: null,
        gatherProviderKey: null,
        gatherModel: null,
        gatherUsageJson: null,
        gatherLatencyMs: null,
        synthProviderKey: null,
        synthModel: null,
        synthUsageJson: null,
        synthLatencyMs: null,
        metadataJson: null,
        startedAt: null,
        completedAt: null,
        heartbeatAt: null,
        createdAt: "2026-03-31T10:00:00.000Z",
        updatedAt: "2026-03-31T10:00:00.000Z",
      };
    });
    return harness.state.run;
  }),
  insertResearchLabEvidence: vi.fn(async (_env: unknown, records: any[]) => {
    harness.state.evidence.push(...records);
  }),
  insertResearchLabOutput: vi.fn(async (_env: unknown, input: any) => {
    harness.state.outputCounter += 1;
    const output = {
      id: `output-${harness.state.outputCounter}`,
      runId: input.runId,
      runItemId: input.runItemId,
      ticker: input.ticker,
      profileId: input.profileId ?? null,
      profileVersionId: input.profileVersionId ?? null,
      promptConfigId: input.promptConfigId,
      evidenceProfileId: input.evidenceProfileId,
      priorOutputId: input.priorOutputId,
      synthesisJson: input.synthesisJson,
      memorySummaryJson: input.memorySummaryJson,
      deltaJson: input.deltaJson,
      sourceEvidenceIds: input.sourceEvidenceIds,
      model: input.model,
      usageJson: input.usageJson,
      createdAt: "2026-03-31T10:05:00.000Z",
    };
    harness.state.outputs.push(output);
    return output;
  }),
  insertResearchLabRunEvent: vi.fn(async (_env: unknown, input: any) => {
    harness.state.eventCounter += 1;
    const event = {
      id: `event-${harness.state.eventCounter}`,
      runId: input.runId,
      runItemId: input.runItemId ?? null,
      ticker: input.ticker ?? null,
      eventType: input.eventType,
      level: input.level,
      message: input.message,
      contextJson: input.contextJson ?? null,
      createdAt: `2026-03-31T10:00:${String(harness.state.eventCounter).padStart(2, "0")}.000Z`,
    };
    harness.state.events.push(event);
    return event;
  }),
  listResearchLabRuns: vi.fn(async () => []),
  loadDefaultResearchLabEvidenceProfile: vi.fn(async () => harness.state.evidenceProfile),
  loadDefaultResearchLabPromptConfig: vi.fn(async () => harness.state.promptConfig),
  loadLatestResearchLabOutputForTicker: vi.fn(async (_env: unknown, ticker: string) => harness.state.priorOutputs.get(ticker) ?? null),
  loadResearchLabEvidenceProfile: vi.fn(async () => harness.state.evidenceProfile),
  loadResearchLabPromptConfig: vi.fn(async () => harness.state.promptConfig),
  loadResearchLabRun: vi.fn(async (_env: unknown, runId: string) => (
    harness.state.run && harness.state.run.id === runId ? harness.state.run : null
  )),
  loadResearchLabRunItems: vi.fn(async (_env: unknown, runId: string) => (
    harness.state.items.filter((item) => item.runId === runId)
  )),
  tryAcquireResearchLabRunExecution: vi.fn(async () => true),
  updateResearchLabRun: vi.fn(async (_env: unknown, runId: string, patch: any) => {
    if (!harness.state.run || harness.state.run.id !== runId) return null;
    harness.state.run = { ...harness.state.run, ...patch, updatedAt: "2026-03-31T10:10:00.000Z" };
    return harness.state.run;
  }),
  updateResearchLabRunHeartbeat: vi.fn(async (_env: unknown, runId: string, heartbeatAt?: string) => {
    if (harness.state.run && harness.state.run.id === runId) {
      harness.state.run.heartbeatAt = heartbeatAt ?? "2026-03-31T10:10:00.000Z";
    }
  }),
  updateResearchLabRunItem: vi.fn(async (_env: unknown, runItemId: string, patch: any) => {
    const index = harness.state.items.findIndex((item) => item.id === runItemId);
    if (index < 0) return null;
    harness.state.items[index] = { ...harness.state.items[index], ...patch, updatedAt: "2026-03-31T10:10:00.000Z" };
    return harness.state.items[index];
  }),
  updateResearchLabRunItemHeartbeat: vi.fn(async (_env: unknown, runItemId: string, heartbeatAt?: string) => {
    const index = harness.state.items.findIndex((item) => item.id === runItemId);
    if (index >= 0) {
      harness.state.items[index].heartbeatAt = heartbeatAt ?? "2026-03-31T10:10:00.000Z";
    }
  }),
  claimNextQueuedResearchLabRunItem: vi.fn(async (_env: unknown, runId: string) => {
    const item = harness.state.items.find((entry) => entry.runId === runId && entry.status === "queued");
    if (!item) return null;
    item.status = "memory_loading";
    item.startedAt = item.startedAt ?? "2026-03-31T10:00:00.000Z";
    item.heartbeatAt = "2026-03-31T10:00:01.000Z";
    return item;
  }),
  upsertResearchLabMemoryHead: vi.fn(async (_env: unknown, head: any) => {
    harness.state.memoryHeads.set(`${head.ticker}:${head.promptConfigFamily}`, head);
  }),
  loadResearchLabEvidenceForRunItem: vi.fn(async (_env: unknown, runItemId: string) => (
    harness.state.evidence.filter((entry) => entry.runItemId === runItemId)
  )),
  loadResearchLabEvidenceForRun: vi.fn(async (_env: unknown, runId: string) => (
    harness.state.evidence.filter((entry) => entry.runId === runId)
  )),
  loadResearchLabOutputForRunItem: vi.fn(async (_env: unknown, runItemId: string) => (
    harness.state.outputs.find((entry) => entry.runItemId === runItemId) ?? null
  )),
  loadResearchLabOutputsForRun: vi.fn(async (_env: unknown, runId: string) => (
    harness.state.outputs.filter((entry) => entry.runId === runId)
  )),
  loadResearchLabTickerHistory: vi.fn(async (_env: unknown, ticker: string) => (
    harness.state.outputs.filter((entry) => entry.ticker === ticker).map((output) => ({
      output,
      run: harness.state.run,
    }))
  )),
  loadResearchLabRunEvents: vi.fn(async (_env: unknown, runId: string) => (
    harness.state.events.filter((event) => event.runId === runId)
  )),
  cancelResearchLabRun: vi.fn(async (_env: unknown, runId: string) => {
    if (!harness.state.run || harness.state.run.id !== runId) return null;
    harness.state.items = harness.state.items.map((item) => (
      ["completed", "failed"].includes(item.status)
        ? item
        : {
          ...item,
          status: "failed",
          lastError: item.lastError ?? "Cancelled by user.",
          completedAt: item.completedAt ?? "2026-03-31T10:10:00.000Z",
          heartbeatAt: "2026-03-31T10:10:00.000Z",
        }
    ));
    harness.state.run = {
      ...harness.state.run,
      status: "cancelled",
      completedAt: "2026-03-31T10:10:00.000Z",
      heartbeatAt: "2026-03-31T10:10:00.000Z",
      failedTickerCount: harness.state.items.filter((item) => item.status === "failed").length,
      completedTickerCount: harness.state.items.filter((item) => item.status === "completed").length,
    };
    return harness.state.run;
  }),
}));

import { loadResearchLabRunResultsPayload, loadResearchLabRunStatusPayload, loadResearchLabRunStreamPayload } from "../src/research-lab/api";
import { cancelResearchLabRun, drainResearchLabRun, ensureResearchLabRunProgress, startResearchLabRun } from "../src/research-lab/orchestrator";
import * as researchLabStorage from "../src/research-lab/storage";

async function progressToTerminal(env: any, runId: string, maxPasses = 12) {
  let latest = null as any;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    latest = await ensureResearchLabRunProgress(env, runId);
    if (latest && ["completed", "partial", "failed", "cancelled"].includes(latest.status)) {
      return latest;
    }
  }
  return latest;
}

describe("research lab flow", () => {
  beforeEach(() => {
    harness.reset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a successful end-to-end lab flow with persisted evidence, output, and events", async () => {
    const env = {} as any;
    const run = await startResearchLabRun(env, { tickers: ["KMI", "LASR"] });

    await progressToTerminal(env, run.id);

    expect(harness.state.run.status).toBe("completed");
    expect(harness.state.outputs).toHaveLength(2);
    expect(harness.state.evidence).toHaveLength(2);
    expect(harness.state.items.every((item) => item.status === "completed")).toBe(true);
    expect(harness.state.events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "run_created",
      "memory_load_started",
      "gathering_started",
      "gathering_finished",
      "synthesis_started",
      "synthesis_finished",
      "persistence_started",
      "persistence_finished",
      "run_completed",
    ]));
  });

  it("stores profile-backed runs without writing synthetic profile version ids into legacy config foreign keys", async () => {
    harness.state.promptConfig = {
      ...harness.state.promptConfig,
      id: harness.state.profileVersion.id,
      configFamily: `profile:${harness.state.profile.id}`,
    };
    harness.state.evidenceProfile = {
      ...harness.state.evidenceProfile,
      id: harness.state.profileVersion.id,
      configFamily: `profile:${harness.state.profile.id}`,
    };
    const env = {} as any;

    await startResearchLabRun(env, { tickers: ["KMI"] });

    expect(vi.mocked(researchLabStorage.createResearchLabRun).mock.calls.at(-1)?.[1]).toMatchObject({
      profileId: harness.state.profile.id,
      profileVersionId: harness.state.profileVersion.id,
      promptConfigId: null,
      evidenceProfileId: null,
    });
  });

  it("marks the ticker failed when Perplexity gathering fails and persists no output", async () => {
    harness.state.gatherError = new Error("Perplexity search failed.");
    const env = {} as any;
    const run = await startResearchLabRun(env, { tickers: ["KMI"] });

    await progressToTerminal(env, run.id);

    expect(harness.state.run.status).toBe("failed");
    expect(harness.state.items[0]?.status).toBe("failed");
    expect(harness.state.items[0]?.lastError).toContain("Perplexity");
    expect(harness.state.outputs).toHaveLength(0);
    expect(harness.state.events.some((event) => event.eventType === "gathering_failed")).toBe(true);
  });

  it("keeps research-lab heartbeats alive while a long gather is still running", async () => {
    vi.useFakeTimers();
    harness.state.gatherDelayMs = 25_000;
    const env = {} as any;
    const run = await startResearchLabRun(env, { tickers: ["AMPX"] });

    const drainPromise = drainResearchLabRun(env, run.id);
    await vi.advanceTimersByTimeAsync(21_000);

    expect(vi.mocked(researchLabStorage.updateResearchLabRunHeartbeat).mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(vi.mocked(researchLabStorage.updateResearchLabRunItemHeartbeat).mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(harness.state.items[0]?.status).toBe("gathering");

    await vi.advanceTimersByTimeAsync(10_000);
    await drainPromise;

    expect(harness.state.items[0]?.status).toBe("completed");
  });

  it("cancels a live lab run without restarting it", async () => {
    const env = {} as any;
    const run = await startResearchLabRun(env, { tickers: ["NVDA", "MSFT"] });
    harness.state.run = {
      ...harness.state.run,
      status: "running",
    };

    const cancelled = await cancelResearchLabRun(env, run.id);

    expect(cancelled?.status).toBe("cancelled");
    expect(harness.state.items.every((item) => item.status === "failed")).toBe(true);
    expect(harness.state.events.some((event) => event.eventType === "run_cancelled")).toBe(true);
  });

  it("marks the ticker failed when Claude synthesis fails even if evidence was gathered", async () => {
    harness.state.synthError = new Error("Claude synthesis failed.");
    const env = {} as any;
    const run = await startResearchLabRun(env, { tickers: ["KMI"] });

    await progressToTerminal(env, run.id);

    expect(harness.state.run.status).toBe("failed");
    expect(harness.state.evidence).toHaveLength(1);
    expect(harness.state.outputs).toHaveLength(0);
    expect(harness.state.items[0]?.status).toBe("failed");
    expect(harness.state.events.some((event) => event.eventType === "synthesis_failed")).toBe(true);
  });

  it("treats malformed synthesis as a hard failure with no fallback output", async () => {
    harness.state.synthError = new Error("Synthesis output failed validation.");
    const env = {} as any;
    const run = await startResearchLabRun(env, { tickers: ["LASR"] });

    await progressToTerminal(env, run.id);

    expect(harness.state.run.status).toBe("failed");
    expect(harness.state.outputs).toHaveLength(0);
    expect(harness.state.items[0]?.lastError).toContain("validation");
  });

  it("converts stale in-progress work into an explicit failure instead of a ready result", async () => {
    const env = {} as any;
    const run = await startResearchLabRun(env, { tickers: ["BG"] });
    harness.state.run = {
      ...harness.state.run,
      status: "running",
      startedAt: "2026-03-31T07:00:00.000Z",
      heartbeatAt: "2026-03-31T07:00:00.000Z",
    };
    harness.state.items[0] = {
      ...harness.state.items[0],
      status: "gathering",
      heartbeatAt: "2026-03-31T07:00:00.000Z",
      startedAt: "2026-03-31T07:00:00.000Z",
    };

    await ensureResearchLabRunProgress(env, run.id);

    expect(harness.state.items[0]?.status).toBe("failed");
    expect(harness.state.items[0]?.lastError).toMatch(/stale/i);
    expect(harness.state.outputs).toHaveLength(0);
    expect(harness.state.run.status).toBe("failed");
  });

  it("does not surface prior memory as the current run result after a failed synthesis", async () => {
    harness.state.priorOutputs.set("KMI", harness.makePriorOutput("KMI"));
    harness.state.synthError = new Error("Claude synthesis failed.");
    const env = {} as any;
    const run = await startResearchLabRun(env, { tickers: ["KMI"] });

    await progressToTerminal(env, run.id);
    const payload = await loadResearchLabRunResultsPayload(env, run.id);

    expect(payload?.items).toHaveLength(1);
    expect(payload?.items[0]?.output).toBeNull();
    expect(payload?.items[0]?.item.status).toBe("failed");
    expect(harness.state.outputs).toHaveLength(0);
  });

  it("builds stream payloads with current status, evidence, output, and structured events", async () => {
    const env = {} as any;
    const run = await startResearchLabRun(env, { tickers: ["KMI"] });

    await progressToTerminal(env, run.id);
    const payload = await loadResearchLabRunStreamPayload(env, run.id);

    expect(payload?.status.run.status).toBe("completed");
    expect(payload?.results.items[0]?.evidence).toHaveLength(1);
    expect(payload?.results.items[0]?.output?.ticker).toBe("KMI");
    expect(payload?.results.items[0]?.events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "gathering_started",
      "synthesis_finished",
      "persistence_finished",
    ]));
  });

  it("derives prompt and evidence details from the active profile version when legacy config ids are null", async () => {
    const env = {} as any;
    const run = await startResearchLabRun(env, { tickers: ["KMI"] });
    harness.state.run = {
      ...harness.state.run,
      promptConfigId: null,
      evidenceProfileId: null,
    };

    const payload = await loadResearchLabRunStatusPayload(env, run.id);

    expect(payload?.profile?.id).toBe(harness.state.profile.id);
    expect(payload?.profileVersion?.id).toBe(harness.state.profileVersion.id);
    expect(payload?.promptConfig?.id).toBe(harness.state.profileVersion.id);
    expect(payload?.evidenceProfile?.id).toBe(harness.state.profileVersion.id);
    expect(payload?.promptConfig?.configFamily).toBe(`profile:${harness.state.profile.id}`);
    expect(payload?.evidenceProfile?.configFamily).toBe(`profile:${harness.state.profile.id}`);
  });

  it("drains a single ticker through all stages in one progress pass", async () => {
    const env = {} as any;
    const run = await startResearchLabRun(env, { tickers: ["DELL"] });

    await drainResearchLabRun(env, run.id);
    expect(harness.state.items[0]?.status).toBe("completed");
    expect(harness.state.outputs).toHaveLength(1);
  });

  it("does not re-enter work when the first non-terminal ticker is already persisting", async () => {
    const env = {} as any;
    const run = await startResearchLabRun(env, { tickers: ["GEV", "APD"] });
    harness.state.run = {
      ...harness.state.run,
      status: "running",
    };
    harness.state.items[0] = {
      ...harness.state.items[0],
      companyName: "GE Vernova Inc.",
      exchange: "NYSE",
      secCik: "0001996810",
      irDomain: "gevernova.com",
      status: "persisting",
      heartbeatAt: new Date().toISOString(),
    };

    const eventCountBefore = harness.state.events.length;
    await drainResearchLabRun(env, run.id);

    expect(harness.state.items[0]?.status).toBe("persisting");
    expect(harness.state.items[1]?.status).toBe("queued");
    expect(harness.state.events).toHaveLength(eventCountBefore);
  });

  it("resolves watchlist-backed runs from the requested source basis and selected tickers", async () => {
    const env = {} as any;
    const run = await startResearchLabRun(env, {
      tickers: [],
      sourceType: "watchlist_set",
      sourceId: "watchlist-set-1",
      sourceBasis: "unique",
      selectedTickers: ["NVDA", "KMI"],
      maxTickers: 1,
    });

    expect(run.sourceType).toBe("watchlist_set");
    expect(run.sourceId).toBe("watchlist-set-1");
    expect(run.requestedTickerCount).toBe(1);
    expect(harness.state.items.map((item) => item.ticker)).toEqual(["KMI"]);
    expect(harness.state.run?.metadataJson).toMatchObject({
      watchlistRunId: "watchlist-run-1",
      sourceBasis: "unique",
    });
  });
});
