import type { Env } from "../types";
import { normalizeResearchTicker } from "../research/sec-normalization";
import {
  RESEARCH_LAB_DEFAULT_EVIDENCE_PROFILE_ID,
  RESEARCH_LAB_DEFAULT_PROMPT_CONFIG_ID,
  RESEARCH_LAB_HEARTBEAT_INTERVAL_MS,
  RESEARCH_LAB_HEARTBEAT_STALE_MS,
} from "./constants";
import { gatherResearchLabEvidence } from "./gather";
import { buildResearchLabMemorySummary, buildResearchLabOutputDelta } from "./memory";
import { validateResearchLabRunCreate } from "./schemas";
import {
  createResearchLabRun,
  cancelResearchLabRun as cancelResearchLabRunRecord,
  insertResearchLabEvidence,
  insertResearchLabOutput,
  insertResearchLabRunEvent,
  listResearchLabRuns,
  loadDefaultResearchLabEvidenceProfile,
  loadDefaultResearchLabPromptConfig,
  loadLatestResearchLabOutputForTicker,
  loadResearchLabEvidenceProfile,
  loadResearchLabPromptConfig,
  loadResearchLabRun,
  loadResearchLabRunItems,
  tryAcquireResearchLabRunExecution,
  updateResearchLabRun,
  updateResearchLabRunHeartbeat,
  updateResearchLabRunItem,
  updateResearchLabRunItemHeartbeat,
  claimNextQueuedResearchLabRunItem,
  upsertResearchLabMemoryHead,
} from "./storage";
import { synthesizeResearchLabOutput } from "./synthesize";
import type {
  ResearchLabEvidenceProfileRecord,
  ResearchLabOutputRecord,
  ResearchLabPromptConfigRecord,
  ResearchLabRunCreateRequest,
  ResearchLabRunItemRecord,
  ResearchLabRunRecord,
  ResearchLabRunStatus,
  ResearchLabTickerIdentity,
} from "./types";

const runExecutions = new Map<string, Promise<void>>();

function nowIso() {
  return new Date().toISOString();
}

function waitMs(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isTerminalRunStatus(status: ResearchLabRunStatus) {
  return status === "completed" || status === "partial" || status === "failed" || status === "cancelled";
}

function isTerminalItemStatus(status: ResearchLabRunItemRecord["status"]) {
  return status === "completed" || status === "failed";
}

function isInProgressItemStatus(status: ResearchLabRunItemRecord["status"]) {
  return status === "memory_loading" || status === "gathering" || status === "synthesizing" || status === "persisting";
}

function ageMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Date.now() - parsed);
}

function dedupeTickers(tickers: string[]) {
  return Array.from(new Set(tickers.map((value) => value.trim().toUpperCase()).filter(Boolean)));
}

function sumUsageRows(rows: Array<Record<string, unknown> | null | undefined>) {
  const total: Record<string, unknown> = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "number") {
        total[key] = (typeof total[key] === "number" ? Number(total[key]) : 0) + value;
      } else if (!(key in total)) {
        total[key] = value;
      }
    }
  }
  return Object.keys(total).length > 0 ? total : null;
}

function summarizeRunUsage(items: ResearchLabRunItemRecord[]) {
  return {
    perplexity: sumUsageRows(items.map((item) => item.gatherUsageJson)),
    anthropic: sumUsageRows(items.map((item) => item.synthUsageJson)),
  };
}

async function touchResearchLabHeartbeat(env: Env, runId: string, runItemId: string, heartbeatAt = nowIso()) {
  await Promise.all([
    updateResearchLabRunHeartbeat(env, runId, heartbeatAt),
    updateResearchLabRunItemHeartbeat(env, runItemId, heartbeatAt),
  ]);
}

async function runWithResearchLabHeartbeat<T>(input: {
  env: Env;
  runId: string;
  runItemId: string;
  work: () => Promise<T>;
  heartbeatEveryMs?: number;
}): Promise<T> {
  const heartbeatEveryMs = Math.max(
    1_000,
    Number(input.heartbeatEveryMs ?? RESEARCH_LAB_HEARTBEAT_INTERVAL_MS),
  );
  const workPromise = input.work();
  await touchResearchLabHeartbeat(input.env, input.runId, input.runItemId);
  while (true) {
    const raced = await Promise.race([
      workPromise.then((value) => ({ done: true as const, value })),
      waitMs(heartbeatEveryMs).then(() => ({ done: false as const })),
    ]);
    if (raced.done) {
      return raced.value;
    }
    try {
      await touchResearchLabHeartbeat(input.env, input.runId, input.runItemId);
    } catch {
      // Best-effort keepalive; surface terminal failures from the underlying work.
    }
  }
}

async function resolveLabConfigs(env: Env, run: ResearchLabRunRecord): Promise<{
  promptConfig: ResearchLabPromptConfigRecord;
  evidenceProfile: ResearchLabEvidenceProfileRecord;
}> {
  const [promptConfig, evidenceProfile] = await Promise.all([
    run.promptConfigId ? loadResearchLabPromptConfig(env, run.promptConfigId) : loadDefaultResearchLabPromptConfig(env),
    run.evidenceProfileId ? loadResearchLabEvidenceProfile(env, run.evidenceProfileId) : loadDefaultResearchLabEvidenceProfile(env),
  ]);
  if (!promptConfig) {
    throw new Error(`Research lab prompt config not found: ${run.promptConfigId ?? RESEARCH_LAB_DEFAULT_PROMPT_CONFIG_ID}`);
  }
  if (!evidenceProfile) {
    throw new Error(`Research lab evidence profile not found: ${run.evidenceProfileId ?? RESEARCH_LAB_DEFAULT_EVIDENCE_PROFILE_ID}`);
  }
  return { promptConfig, evidenceProfile };
}

async function failItem(
  env: Env,
  item: ResearchLabRunItemRecord,
  input: {
    stage: "gathering" | "synthesizing" | "memory_loading" | "persisting";
    message: string;
  },
) {
  const heartbeatAt = nowIso();
  if (input.stage === "gathering") {
    await updateResearchLabRunItem(env, item.id, {
      status: "gathering_failed",
      lastError: input.message,
      heartbeatAt,
    });
    await insertResearchLabRunEvent(env, {
      runId: item.runId,
      runItemId: item.id,
      ticker: item.ticker,
      eventType: "gathering_failed",
      level: "error",
      message: input.message,
    });
  } else {
    await updateResearchLabRunItem(env, item.id, {
      status: "synthesizing_failed",
      lastError: input.message,
      heartbeatAt,
    });
    await insertResearchLabRunEvent(env, {
      runId: item.runId,
      runItemId: item.id,
      ticker: item.ticker,
      eventType: "synthesis_failed",
      level: "error",
      message: input.message,
    });
  }

  await updateResearchLabRunItem(env, item.id, {
    status: "failed",
    lastError: input.message,
    completedAt: heartbeatAt,
    heartbeatAt,
  });
  await updateResearchLabRunHeartbeat(env, item.runId, heartbeatAt);
}

async function recoverStaleItems(env: Env, runId: string) {
  const items = await loadResearchLabRunItems(env, runId);
  for (const item of items) {
    if (!isInProgressItemStatus(item.status)) continue;
    const itemAgeMs = ageMs(item.heartbeatAt ?? item.updatedAt ?? item.startedAt ?? item.createdAt);
    if (itemAgeMs !== null && itemAgeMs < RESEARCH_LAB_HEARTBEAT_STALE_MS) continue;

    if (item.status === "gathering") {
      await failItem(env, item, {
        stage: "gathering",
        message: `Evidence gathering became stale after ${Math.round((itemAgeMs ?? RESEARCH_LAB_HEARTBEAT_STALE_MS) / 1000)}s without a heartbeat.`,
      });
      continue;
    }

    await failItem(env, item, {
      stage: "synthesizing",
      message: `${item.status === "memory_loading" ? "Memory loading" : item.status === "persisting" ? "Persistence" : "Synthesis"} became stale after ${Math.round((itemAgeMs ?? RESEARCH_LAB_HEARTBEAT_STALE_MS) / 1000)}s without a heartbeat.`,
    });
  }
}

async function finalizeRun(env: Env, runId: string) {
  const [run, items] = await Promise.all([
    loadResearchLabRun(env, runId),
    loadResearchLabRunItems(env, runId),
  ]);
  if (!run) return null;
  const completedTickerCount = items.filter((item) => item.status === "completed").length;
  const failedTickerCount = items.filter((item) => item.status === "failed").length;
  const remaining = items.length - completedTickerCount - failedTickerCount;

  let status: ResearchLabRunStatus = run.status;
  if (remaining > 0) {
    status = "running";
  } else if (completedTickerCount === items.length) {
    status = "completed";
  } else if (failedTickerCount === items.length) {
    status = "failed";
  } else if (completedTickerCount > 0 && failedTickerCount > 0) {
    status = "partial";
  }

  const errorSummary = failedTickerCount > 0
    ? items.filter((item) => item.status === "failed").map((item) => `${item.ticker}: ${item.lastError ?? "Failed."}`).join(" | ")
    : null;

  const updated = await updateResearchLabRun(env, runId, {
    status,
    completedTickerCount,
    failedTickerCount,
    providerUsageJson: summarizeRunUsage(items),
    errorSummary,
    completedAt: remaining === 0 ? nowIso() : null,
    heartbeatAt: nowIso(),
  });

  if (updated && remaining === 0) {
    await insertResearchLabRunEvent(env, {
      runId,
      eventType: "run_completed",
      level: status === "completed" ? "info" : status === "partial" ? "warn" : "error",
      message: status === "completed"
        ? `Research lab run completed for ${completedTickerCount} ticker(s).`
        : status === "partial"
          ? `Research lab run completed with ${completedTickerCount} success(es) and ${failedTickerCount} failure(s).`
          : `Research lab run failed for ${failedTickerCount} ticker(s).`,
      contextJson: {
        completedTickerCount,
        failedTickerCount,
        status,
      },
    });
  }

  return updated;
}

async function processItem(env: Env, run: ResearchLabRunRecord, item: ResearchLabRunItemRecord, configs: {
  promptConfig: ResearchLabPromptConfigRecord;
  evidenceProfile: ResearchLabEvidenceProfileRecord;
}) {
  const memoryStartedAt = nowIso();
  await updateResearchLabRunItem(env, item.id, {
    status: "memory_loading",
    lastError: null,
    startedAt: item.startedAt ?? memoryStartedAt,
    heartbeatAt: memoryStartedAt,
  });
  await insertResearchLabRunEvent(env, {
    runId: run.id,
    runItemId: item.id,
    ticker: item.ticker,
    eventType: "memory_load_started",
    level: "info",
    message: `Loading prior memory for ${item.ticker}.`,
  });
  await updateResearchLabRunHeartbeat(env, run.id, memoryStartedAt);

  let identity: ResearchLabTickerIdentity;
  let priorOutput: ResearchLabOutputRecord | null = null;
  try {
    identity = await normalizeResearchTicker(env, item.ticker);
    priorOutput = await loadLatestResearchLabOutputForTicker(env, item.ticker, configs.promptConfig.configFamily);
  } catch (error) {
    await failItem(env, item, {
      stage: "memory_loading",
      message: error instanceof Error ? error.message : "Failed to load prior memory.",
    });
    return;
  }

  await updateResearchLabRunItem(env, item.id, {
    companyName: identity.companyName,
    exchange: identity.exchange,
    secCik: identity.secCik,
    irDomain: identity.irDomain,
    memoryOutputId: priorOutput?.id ?? null,
    metadataJson: priorOutput ? { priorOutputId: priorOutput.id } : null,
    heartbeatAt: nowIso(),
  });
  await insertResearchLabRunEvent(env, {
    runId: run.id,
    runItemId: item.id,
    ticker: item.ticker,
    eventType: "memory_load_finished",
    level: "info",
    message: priorOutput
      ? `Loaded prior memory for ${item.ticker}.`
      : `No prior memory found for ${item.ticker}.`,
    contextJson: {
      priorOutputId: priorOutput?.id ?? null,
      companyName: identity.companyName,
      exchange: identity.exchange,
    },
  });
  if (priorOutput) {
    await insertResearchLabRunEvent(env, {
      runId: run.id,
      runItemId: item.id,
      ticker: item.ticker,
      eventType: "comparison_attached",
      level: "info",
      message: `Attached prior comparison context for ${item.ticker}.`,
      contextJson: {
        priorOutputId: priorOutput.id,
      },
    });
  }

  const gatherStartedAt = nowIso();
  await updateResearchLabRunItem(env, item.id, {
    status: "gathering",
    heartbeatAt: gatherStartedAt,
  });
  await insertResearchLabRunEvent(env, {
    runId: run.id,
    runItemId: item.id,
    ticker: item.ticker,
    eventType: "gathering_started",
    level: "info",
    message: `Gathering Perplexity evidence for ${item.ticker}.`,
    contextJson: {
      provider: "perplexity",
      evidenceProfileId: configs.evidenceProfile.id,
    },
  });
  await updateResearchLabRunHeartbeat(env, run.id, gatherStartedAt);

  let gatherResult: Awaited<ReturnType<typeof gatherResearchLabEvidence>>;
  const gatherClock = Date.now();
  try {
    gatherResult = await runWithResearchLabHeartbeat({
      env,
      runId: run.id,
      runItemId: item.id,
      work: () => gatherResearchLabEvidence(env, {
        runId: run.id,
        runItemId: item.id,
        identity,
        evidenceProfile: configs.evidenceProfile,
      }),
    });
  } catch (error) {
    await failItem(env, item, {
      stage: "gathering",
      message: error instanceof Error ? error.message : "Evidence gathering failed.",
    });
    return;
  }

  await insertResearchLabEvidence(env, gatherResult.evidence);
  await updateResearchLabRunItem(env, item.id, {
    gatherProviderKey: "perplexity",
    gatherModel: gatherResult.model,
    gatherUsageJson: gatherResult.usage,
    gatherLatencyMs: Date.now() - gatherClock,
    heartbeatAt: nowIso(),
  });
  await insertResearchLabRunEvent(env, {
    runId: run.id,
    runItemId: item.id,
    ticker: item.ticker,
    eventType: "gathering_finished",
    level: "info",
    message: `Gathered ${gatherResult.evidence.length} evidence item(s) for ${item.ticker}.`,
    contextJson: {
      evidenceCount: gatherResult.evidence.length,
      model: gatherResult.model,
      usage: gatherResult.usage,
    },
  });

  const synthStartedAt = nowIso();
  await updateResearchLabRunItem(env, item.id, {
    status: "synthesizing",
    heartbeatAt: synthStartedAt,
  });
  await insertResearchLabRunEvent(env, {
    runId: run.id,
    runItemId: item.id,
    ticker: item.ticker,
    eventType: "synthesis_started",
    level: "info",
    message: `Synthesizing ${item.ticker} with Claude Sonnet.`,
    contextJson: {
      provider: "anthropic",
      promptConfigId: configs.promptConfig.id,
    },
  });
  await updateResearchLabRunHeartbeat(env, run.id, synthStartedAt);

  let synthResult: Awaited<ReturnType<typeof synthesizeResearchLabOutput>>;
  const synthClock = Date.now();
  try {
    synthResult = await runWithResearchLabHeartbeat({
      env,
      runId: run.id,
      runItemId: item.id,
      work: () => synthesizeResearchLabOutput(env, {
        identity,
        evidence: gatherResult.evidence,
        promptConfig: configs.promptConfig,
        evidencePromptLimit: gatherResult.promptEvidenceLimit,
        priorOutput,
      }),
    });
  } catch (error) {
    await failItem(env, item, {
      stage: "synthesizing",
      message: error instanceof Error ? error.message : "Synthesis failed.",
    });
    return;
  }

  await updateResearchLabRunItem(env, item.id, {
    status: "persisting",
    synthProviderKey: "anthropic",
    synthModel: synthResult.model,
    synthUsageJson: synthResult.usage,
    synthLatencyMs: Date.now() - synthClock,
    heartbeatAt: nowIso(),
  });
  await insertResearchLabRunEvent(env, {
    runId: run.id,
    runItemId: item.id,
    ticker: item.ticker,
    eventType: "synthesis_finished",
    level: "info",
    message: `Synthesis completed for ${item.ticker}.`,
    contextJson: {
      model: synthResult.model,
      usage: synthResult.usage,
    },
  });

  await insertResearchLabRunEvent(env, {
    runId: run.id,
    runItemId: item.id,
    ticker: item.ticker,
    eventType: "persistence_started",
    level: "info",
    message: `Persisting lab artifacts for ${item.ticker}.`,
  });
  const memorySummary = buildResearchLabMemorySummary(synthResult.synthesis);
  const delta = buildResearchLabOutputDelta(synthResult.synthesis, priorOutput);

  const output = await insertResearchLabOutput(env, {
    runId: run.id,
    runItemId: item.id,
    ticker: item.ticker,
    promptConfigId: configs.promptConfig.id,
    evidenceProfileId: configs.evidenceProfile.id,
    priorOutputId: priorOutput?.id ?? null,
    synthesisJson: synthResult.synthesis,
    memorySummaryJson: memorySummary,
    deltaJson: delta,
    sourceEvidenceIds: synthResult.synthesis.evidenceIds,
    model: synthResult.model,
    usageJson: synthResult.usage,
  });
  await upsertResearchLabMemoryHead(env, {
    ticker: item.ticker,
    promptConfigFamily: configs.promptConfig.configFamily,
    latestOutputId: output.id,
    updatedAt: nowIso(),
  });
  await updateResearchLabRunItem(env, item.id, {
    status: "completed",
    memoryOutputId: output.id,
    synthProviderKey: "anthropic",
    synthModel: synthResult.model,
    synthUsageJson: synthResult.usage,
    synthLatencyMs: Date.now() - synthClock,
    completedAt: nowIso(),
    heartbeatAt: nowIso(),
  });
  await insertResearchLabRunEvent(env, {
    runId: run.id,
    runItemId: item.id,
    ticker: item.ticker,
    eventType: "persistence_finished",
    level: "info",
    message: `Persisted final synthesis for ${item.ticker}.`,
    contextJson: {
      outputId: output.id,
      priorOutputId: priorOutput?.id ?? null,
    },
  });
  await updateResearchLabRunHeartbeat(env, run.id, nowIso());
}

async function executeDrain(env: Env, runId: string) {
  let run = await loadResearchLabRun(env, runId);
  if (!run || isTerminalRunStatus(run.status)) return;

  await recoverStaleItems(env, runId);
  run = await finalizeRun(env, runId) ?? run;
  if (isTerminalRunStatus(run.status)) return;

  const executionToken = crypto.randomUUID();
  const acquired = await tryAcquireResearchLabRunExecution(
    env,
    runId,
    executionToken,
    new Date(Date.now() - RESEARCH_LAB_HEARTBEAT_STALE_MS).toISOString(),
  );
  if (!acquired) return;

  run = await updateResearchLabRun(env, runId, {
    status: "running",
    startedAt: run.startedAt ?? nowIso(),
    heartbeatAt: nowIso(),
  }) ?? run;
  const configs = await resolveLabConfigs(env, run);

  while (true) {
    await updateResearchLabRunHeartbeat(env, runId, nowIso());
    const item = await claimNextQueuedResearchLabRunItem(env, runId);
    if (!item) break;
    await processItem(env, run, item, configs);
  }

  await finalizeRun(env, runId);
}

export async function startResearchLabRun(env: Env, payload: ResearchLabRunCreateRequest) {
  const request = validateResearchLabRunCreate(payload);
  const tickers = dedupeTickers(request.tickers);
  if (tickers.length === 0) {
    throw new Error("At least one ticker is required.");
  }
  const [promptConfig, evidenceProfile] = await Promise.all([
    request.promptConfigId ? loadResearchLabPromptConfig(env, request.promptConfigId) : loadDefaultResearchLabPromptConfig(env),
    request.evidenceProfileId ? loadResearchLabEvidenceProfile(env, request.evidenceProfileId) : loadDefaultResearchLabEvidenceProfile(env),
  ]);
  if (!promptConfig) {
    throw new Error(`Research lab prompt config not found: ${request.promptConfigId ?? RESEARCH_LAB_DEFAULT_PROMPT_CONFIG_ID}`);
  }
  if (!evidenceProfile) {
    throw new Error(`Research lab evidence profile not found: ${request.evidenceProfileId ?? RESEARCH_LAB_DEFAULT_EVIDENCE_PROFILE_ID}`);
  }

  const run = await createResearchLabRun(env, {
    request: { ...request, tickers },
    tickers,
    sourceType: "manual",
    sourceLabel: "Research Lab",
    promptConfigId: promptConfig.id,
    evidenceProfileId: evidenceProfile.id,
  });
  await insertResearchLabRunEvent(env, {
    runId: run.id,
    eventType: "run_created",
    level: "info",
    message: `Created research lab run for ${tickers.join(", ")}.`,
    contextJson: {
      tickers,
      promptConfigId: promptConfig.id,
      evidenceProfileId: evidenceProfile.id,
    },
  });
  return run;
}

export async function cancelResearchLabRun(env: Env, runId: string): Promise<ResearchLabRunRecord | null> {
  const existing = await loadResearchLabRun(env, runId);
  if (!existing) return null;
  if (existing.status === "completed" || existing.status === "partial" || existing.status === "failed" || existing.status === "cancelled") {
    return existing;
  }
  const run = await cancelResearchLabRunRecord(env, runId);
  if (!run || run.status !== "cancelled") return run;
  await insertResearchLabRunEvent(env, {
    runId,
    eventType: "run_cancelled",
    level: "warn",
    message: "Research lab run cancelled by user.",
  });
  return run;
}

export async function drainResearchLabRun(env: Env, runId: string): Promise<ResearchLabRunRecord | null> {
  const existing = runExecutions.get(runId);
  if (existing) {
    await existing;
    return loadResearchLabRun(env, runId);
  }
  const promise = (async () => {
    try {
      await executeDrain(env, runId);
    } finally {
      runExecutions.delete(runId);
    }
  })();
  runExecutions.set(runId, promise);
  await promise;
  return loadResearchLabRun(env, runId);
}

export async function ensureResearchLabRunProgress(env: Env, runId: string): Promise<ResearchLabRunRecord | null> {
  const run = await loadResearchLabRun(env, runId);
  if (!run || isTerminalRunStatus(run.status)) return run;
  await recoverStaleItems(env, runId);
  const refreshed = await finalizeRun(env, runId);
  if (refreshed && isTerminalRunStatus(refreshed.status)) return refreshed;
  await drainResearchLabRun(env, runId);
  return loadResearchLabRun(env, runId);
}

export { listResearchLabRuns };
