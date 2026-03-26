import type { Env } from "../types";
import {
  DEFAULT_RESEARCH_SLICE_TICKERS,
  RESEARCH_EXECUTION_STALE_SECONDS,
  RESEARCH_HEARTBEAT_STALE_MS,
  RESEARCH_MAX_TICKER_ATTEMPTS,
} from "./constants";
import { buildTopicEvidencePackets, searchItemsToEvidence, secFactsToEvidence, secFilingsToEvidence } from "./evidence";
import { extractResearchCard, fallbackExtractResearchCard } from "./extraction";
import { buildSnapshotComparison } from "./history";
import { resolveResearchProfile } from "./profiles";
import { appendActivityPayload, buildStaleFailureMessage, buildStaleRecoveryMessage, type ResearchActivityLevel } from "./progress";
import { getSearchResearchProvider, getSecResearchProvider } from "./providers";
import { buildMarketSearchQueries, buildTickerSearchQueries } from "./search-queries";
import { computeFactorCards, computeAttentionScore, derivePriorityBucket } from "./scoring";
import { normalizeResearchTicker } from "./sec-normalization";
import { buildFallbackDeepDive, deepDiveResearchCard, fallbackRankResearchCards, rankResearchCards } from "./synthesis";
import {
  countRunTickerStatuses,
  createResearchRun,
  cancelResearchRun,
  claimNextRunnableResearchTicker,
  findFreshEvidenceByCacheKey,
  insertResearchEvidence,
  insertResearchFactor,
  insertResearchRanking,
  insertResearchSnapshot,
  linkResearchEvidence,
  listQueuedResearchRuns,
  loadResearchRun,
  loadResearchRunTickers,
  loadResearchSnapshot,
  loadRunRankings,
  loadRunTickerEvidence,
  loadTickerResearchHistory,
  tryAcquireResearchRunExecution,
  updateResearchRun,
  updateResearchRunHeartbeat,
  updateResearchRunTicker,
  updateResearchRunTickerHeartbeat,
  upsertTickerResearchHead,
} from "./storage";
import type {
  ResearchEvidenceRecord,
  PeerContextPacket,
  TopicEvidencePacket,
  ResearchRunRecord,
  ResearchRunRequest,
  ResearchRunTickerRecord,
  StandardizedResearchCard,
} from "./types";
import { loadWatchlistCompiledRows, loadWatchlistUniqueRows, loadWatchlistSet } from "../watchlist-compiler-service";
import { loadPreferredResearchPeerContext } from "../peer-groups-service";

function nowIso() {
  return new Date().toISOString();
}

function startOfCurrentUtcDayIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).toISOString();
}

function sumUsage(base: Record<string, unknown> | null | undefined, incoming: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!base && !incoming) return null;
  const output: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (typeof value === "number" && typeof output[key] === "number") {
      output[key] = Number(output[key]) + value;
    } else if (typeof value === "number") {
      output[key] = value;
    } else {
      output[key] = value;
    }
  }
  return output;
}

function mergeJson(base: Record<string, unknown> | null | undefined, patch: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return {
    ...(base ?? {}),
    ...(patch ?? {}),
  };
}

function appendWarning(payload: Record<string, unknown> | null | undefined, warning: string): Record<string, unknown> {
  const warnings = Array.isArray((payload as { warnings?: unknown } | null | undefined)?.warnings)
    ? ((payload as { warnings?: unknown[] }).warnings ?? []).map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  return {
    ...(payload ?? {}),
    warnings: Array.from(new Set([...warnings, warning])),
  };
}

async function touchResearchHeartbeat(env: Env, runId: string, runTickerId?: string | null): Promise<void> {
  await updateResearchRunHeartbeat(env, runId);
  if (runTickerId) {
    await updateResearchRunTickerHeartbeat(env, runTickerId);
  }
}

async function persistRunActivity(env: Env, state: {
  id: string;
  provenanceJson: Record<string, unknown> | null;
  providerUsageJson: Record<string, unknown> | null;
}, input: {
  message: string;
  level?: ResearchActivityLevel;
  currentStep?: string | null;
  warning?: boolean;
}): Promise<void> {
  state.provenanceJson = appendActivityPayload(state.provenanceJson, {
    message: input.message,
    level: input.level ?? "info",
  });
  if (input.currentStep !== undefined) {
    state.provenanceJson = mergeJson(state.provenanceJson, { currentStep: input.currentStep });
  }
  if (input.warning) {
    state.provenanceJson = appendWarning(state.provenanceJson, input.message);
  }
  await updateResearchRun(env, state.id, {
    providerUsageJson: state.providerUsageJson,
    provenanceJson: state.provenanceJson,
  });
}

async function collectTickerEvidence(env: Env, input: {
  run: ResearchRunRecord;
  runTicker: ResearchRunTickerRecord;
  companyName: string | null;
  secCik: string | null;
  irDomain: string | null;
  profile: Awaited<ReturnType<typeof resolveResearchProfile>>;
  touchHeartbeat?: () => Promise<void>;
  reportProgress?: (event: {
    message: string;
    level?: ResearchActivityLevel;
    stageMetricsPatch?: Record<string, unknown>;
  }) => Promise<void>;
}): Promise<{
  evidence: ResearchEvidenceRecord[];
  usage: Record<string, unknown> | null;
  warnings: string[];
  metrics: Record<string, unknown>;
}> {
  const secProvider = getSecResearchProvider(env);
  const searchProvider = getSearchResearchProvider(env);
  const evidence: ResearchEvidenceRecord[] = [];
  let usage: Record<string, unknown> | null = null;
  const warnings: string[] = [];
  let secFilingsCount = 0;
  let secFactsCount = 0;
  let cachedEvidenceCount = 0;
  let newEvidenceCount = 0;

  if (input.profile.version.settings.sourceFamilies.sec && input.secCik) {
    await input.touchHeartbeat?.();
    await input.reportProgress?.({
      message: "Loading SEC filings and structured facts.",
      stageMetricsPatch: {
        currentStage: "retrieving",
        currentStep: "Loading SEC filings and facts",
      },
    });
    const [filings, facts] = await Promise.all([
      secProvider.fetchRecentFilings(input.secCik, env).catch(() => []),
      secProvider.fetchStructuredFacts(input.secCik, env).catch(() => []),
    ]);
    secFilingsCount = filings.length;
    secFactsCount = facts.length;
    const secEvidence = [
      ...secFilingsToEvidence(input.runTicker.ticker, input.secCik, filings),
      ...secFactsToEvidence(input.runTicker.ticker, input.secCik, facts),
    ];
    for (const [index, item] of secEvidence.entries()) {
      const stored = await insertResearchEvidence(env, item);
      await linkResearchEvidence(env, input.run.id, input.runTicker.id, stored.id, "primary", index + 1);
      evidence.push(stored);
      newEvidenceCount += 1;
    }
    await input.reportProgress?.({
      message: `SEC evidence complete: ${secEvidence.length} item(s) from ${secFilingsCount} filing(s) and ${secFactsCount} fact set(s).`,
      stageMetricsPatch: {
        secFilingsCount,
        secFactsCount,
        evidenceCount: evidence.length,
      },
    });
  } else if (input.profile.version.settings.sourceFamilies.sec) {
    warnings.push("SEC issuer mapping was unavailable for this ticker.");
    await input.reportProgress?.({
      message: "SEC issuer mapping was unavailable for this ticker.",
      level: "warn",
      stageMetricsPatch: {
        secFilingsCount: 0,
        secFactsCount: 0,
      },
    });
  }

  const queries = buildTickerSearchQueries({
    ticker: input.runTicker.ticker,
    companyName: input.companyName,
    irDomain: input.irDomain,
    template: input.profile.bundle.searchTemplate,
    settings: input.profile.version.settings,
  });
  for (const [queryIndex, query] of queries.entries()) {
    try {
      await input.touchHeartbeat?.();
      await input.reportProgress?.({
        message: `Running search ${queryIndex + 1}/${queries.length}: ${query.label}.`,
        stageMetricsPatch: {
          currentStage: "retrieving",
          currentStep: `Search ${queryIndex + 1}/${queries.length}: ${query.label}`,
          searchQueriesTotal: queries.length,
          searchQueriesCompleted: queryIndex,
          lastQueryLabel: query.label,
        },
      });
      const freshDate = startOfCurrentUtcDayIso();
      const result = await searchProvider.search(env, query, { forceFresh: input.run.refreshMode === "force_fresh" });
      usage = sumUsage(usage, result.usage);
      const searchEvidence = searchItemsToEvidence(result.items);
      for (const item of searchEvidence) {
        const cached = input.run.refreshMode === "reuse_fresh_search_cache"
          ? await findFreshEvidenceByCacheKey(env, item.cacheKey, freshDate)
          : null;
        const stored = cached ?? await insertResearchEvidence(env, item);
        await linkResearchEvidence(env, input.run.id, input.runTicker.id, stored.id, "primary", evidence.length + 1);
        evidence.push(stored);
        if (cached) {
          cachedEvidenceCount += 1;
        } else {
          newEvidenceCount += 1;
        }
      }
      await input.reportProgress?.({
        message: `Search ${query.label} returned ${searchEvidence.length} item(s) (${cachedEvidenceCount} cached, ${newEvidenceCount} new so far).`,
        stageMetricsPatch: {
          evidenceCount: evidence.length,
          cachedEvidenceCount,
          newEvidenceCount,
          searchQueriesTotal: queries.length,
          searchQueriesCompleted: queryIndex + 1,
          lastQueryLabel: query.label,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : `Search query ${query.key} failed.`;
      warnings.push(message);
      await input.reportProgress?.({
        message: `Search ${query.label} failed: ${message}`,
        level: "warn",
        stageMetricsPatch: {
          searchQueriesTotal: queries.length,
          searchQueriesCompleted: queryIndex + 1,
          lastQueryLabel: query.label,
        },
      });
    }
  }

  return {
    evidence,
    usage,
    warnings,
    metrics: {
      secFilingsCount,
      secFactsCount,
      cachedEvidenceCount,
      newEvidenceCount,
      searchQueriesTotal: queries.length,
      searchQueriesCompleted: queries.length,
      evidenceCount: evidence.length,
    },
  };
}

async function collectMarketEvidence(env: Env, input: {
  run: ResearchRunRecord;
  runTickers: ResearchRunTickerRecord[];
  profile: Awaited<ReturnType<typeof resolveResearchProfile>>;
  touchHeartbeat?: () => Promise<void>;
}): Promise<{ evidence: ResearchEvidenceRecord[]; usage: Record<string, unknown> | null }> {
  const searchProvider = getSearchResearchProvider(env);
  const queries = buildMarketSearchQueries({
    template: input.profile.bundle.searchTemplate,
    settings: input.profile.version.settings,
  });
  const evidence: ResearchEvidenceRecord[] = [];
  let usage: Record<string, unknown> | null = null;
  for (const query of queries) {
    try {
      await input.touchHeartbeat?.();
      const result = await searchProvider.search(env, query, { forceFresh: input.run.refreshMode === "force_fresh" });
      usage = sumUsage(usage, result.usage);
      const searchEvidence = searchItemsToEvidence(result.items);
      for (const item of searchEvidence) {
        const stored = await insertResearchEvidence(env, item);
        evidence.push(stored);
        for (const [index, runTicker] of input.runTickers.entries()) {
          await linkResearchEvidence(env, input.run.id, runTicker.id, stored.id, "macro_context", 1000 + index);
        }
      }
    } catch {
      // Best-effort only.
    }
  }
  return { evidence, usage };
}

async function processResearchTicker(env: Env, run: ResearchRunRecord, runTicker: ResearchRunTickerRecord): Promise<{ usage: Record<string, unknown> | null; warnings: string[] }> {
  const profile = await resolveResearchProfile(env, run.profileId);
  const normalized = await normalizeResearchTicker(env, runTicker.ticker);
  let stageMetrics = mergeJson(runTicker.stageMetricsJson, {
    attemptNumber: runTicker.attemptCount + 1,
    maxAttempts: RESEARCH_MAX_TICKER_ATTEMPTS,
    currentStage: "normalizing",
    currentStep: "Resolving company metadata",
  });
  let workingJson = mergeJson(runTicker.workingJson, {});
  const persistTickerProgress = async (input: {
    status?: ResearchRunTickerRecord["status"];
    companyName?: string | null;
    exchange?: string | null;
    secCik?: string | null;
    irDomain?: string | null;
    attemptCount?: number;
    lastError?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    metricsPatch?: Record<string, unknown>;
    workingPatch?: Record<string, unknown>;
    logMessage?: string;
    logLevel?: ResearchActivityLevel;
    touchRunHeartbeat?: boolean;
  }) => {
    if (input.metricsPatch) {
      stageMetrics = mergeJson(stageMetrics, input.metricsPatch);
    }
    if (input.workingPatch) {
      workingJson = mergeJson(workingJson, input.workingPatch);
    }
    if (input.logMessage) {
      stageMetrics = appendActivityPayload(stageMetrics, {
        message: input.logMessage,
        level: input.logLevel ?? "info",
      });
    }
    await updateResearchRunTicker(env, runTicker.id, {
      status: input.status,
      companyName: input.companyName,
      exchange: input.exchange,
      secCik: input.secCik,
      irDomain: input.irDomain,
      attemptCount: input.attemptCount,
      lastError: input.lastError,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      stageMetricsJson: stageMetrics,
      workingJson,
    });
    if (input.touchRunHeartbeat) {
      await updateResearchRunHeartbeat(env, run.id);
    }
  };
  const touchHeartbeat = async () => {
    await touchResearchHeartbeat(env, run.id, runTicker.id);
  };
  stageMetrics = appendActivityPayload(mergeJson(stageMetrics, {
    currentStage: "retrieving",
    currentStep: "Collecting ticker evidence",
    normalizationStatus: "resolved",
  }), {
    message: `Ticker processing started (attempt ${runTicker.attemptCount + 1}/${RESEARCH_MAX_TICKER_ATTEMPTS}).`,
  });
  await updateResearchRunTicker(env, runTicker.id, {
    status: "retrieving",
    attemptCount: runTicker.attemptCount + 1,
    companyName: normalized.companyName,
    exchange: normalized.exchange,
    secCik: normalized.secCik,
    irDomain: normalized.irDomain,
    normalizationJson: normalized,
    startedAt: runTicker.startedAt ?? nowIso(),
    lastError: null,
    stageMetricsJson: stageMetrics,
  });
  const collected = await runWithHeartbeat({
    touchHeartbeat,
    onHeartbeat: async (elapsedMs, beatCount) => {
      if (beatCount % 2 !== 0) return;
      await persistTickerProgress({
        metricsPatch: {
          currentStage: "retrieving",
          currentStep: `Collecting ticker evidence (${formatElapsedLabel(elapsedMs)})`,
          retrievalElapsedMs: elapsedMs,
        },
        logMessage: `Still gathering evidence (${formatElapsedLabel(elapsedMs)} elapsed).`,
        touchRunHeartbeat: false,
      });
    },
    work: () => collectTickerEvidence(env, {
      run,
      runTicker,
      companyName: normalized.companyName,
      secCik: normalized.secCik,
      irDomain: normalized.irDomain,
      profile,
      touchHeartbeat,
      reportProgress: async (event) => {
        await persistTickerProgress({
          metricsPatch: event.stageMetricsPatch,
          logMessage: event.message,
          logLevel: event.level,
          touchRunHeartbeat: true,
        });
      },
    }),
  });
  const topicPackets: TopicEvidencePacket[] = buildTopicEvidencePackets(collected.evidence, profile.version.settings);
  const peerContext: PeerContextPacket = profile.version.settings.peerComparisonEnabled !== false
    ? await loadPreferredResearchPeerContext(env, runTicker.ticker, profile.version.settings.maxPeerCandidates ?? 3)
    : {
      available: false,
      confidence: "low",
      reasonUnavailable: "Peer comparison is disabled in the active research profile.",
      peerGroupId: null,
      peerGroupName: null,
      source: "none",
      whyTheseAreClosestPeers: "",
      closestPeers: [],
    };
  await touchHeartbeat();
  await persistTickerProgress({
    status: "extracting",
    metricsPatch: mergeJson(collected.metrics, {
      currentStage: "extracting",
      currentStep: "Sending evidence to extraction model",
      evidenceCount: collected.evidence.length,
      warningCount: collected.warnings.length,
      topicPacketCount: topicPackets.length,
      peerComparisonAvailable: peerContext.available,
    }),
    workingPatch: {
      topicPackets,
      peerContext,
    },
    logMessage: `Evidence collection complete with ${collected.evidence.length} item(s) and ${collected.warnings.length} warning(s).`,
    logLevel: collected.warnings.length > 0 ? "warn" : "info",
    touchRunHeartbeat: true,
  });
  await persistTickerProgress({
    metricsPatch: {
      currentStage: "extracting",
      currentStep: `Submitting ${collected.evidence.length} evidence item(s) to extraction`,
    },
    logMessage: `Submitting ${collected.evidence.length} evidence item(s) to the extraction model.`,
    touchRunHeartbeat: true,
  });
  const extracted = await runWithHeartbeat({
    touchHeartbeat,
    onHeartbeat: async (elapsedMs) => {
      await persistTickerProgress({
        metricsPatch: {
          currentStage: "extracting",
          currentStep: `Waiting on extraction model (${formatElapsedLabel(elapsedMs)})`,
          extractionElapsedMs: elapsedMs,
        },
        logMessage: `Still waiting on extraction model (${formatElapsedLabel(elapsedMs)} elapsed).`,
        touchRunHeartbeat: false,
      });
    },
    work: () => extractResearchCard(env, {
      ticker: runTicker.ticker,
      companyName: normalized.companyName,
      evidence: collected.evidence,
      prompt: profile.bundle.haiku,
      settings: profile.version.settings,
      peerContext,
      topicPackets,
    }),
  });
  const warnings = extracted.warning ? [...collected.warnings, extracted.warning] : collected.warnings;
  await persistTickerProgress({
    status: "ranking_ready",
    workingPatch: {
      card: extracted.card,
      extractionModel: extracted.model,
      topicPackets,
      peerContext,
      warnings,
    },
    metricsPatch: mergeJson(collected.metrics, {
      currentStage: "ranking_ready",
      currentStep: "Awaiting run-level ranking",
      evidenceCount: collected.evidence.length,
      warningCount: warnings.length,
      extractionUsage: extracted.usage,
    }),
    logMessage: extracted.warning
      ? `Extraction completed with fallback: ${extracted.warning}`
      : `Extraction completed via ${extracted.model}.`,
    logLevel: extracted.warning ? "warn" : "info",
    touchRunHeartbeat: true,
  });
  return {
    usage: sumUsage(collected.usage, extracted.usage),
    warnings,
  };
}

async function finalizeResearchRun(
  env: Env,
  run: ResearchRunRecord,
  options?: {
    forceDeterministic?: boolean;
    recoveryReason?: string | null;
  },
): Promise<void> {
  const profile = await resolveResearchProfile(env, run.profileId);
  const runTickers = await loadResearchRunTickers(env, run.id);
  const ready = runTickers.filter((row) => row.status === "ranking_ready" && row.workingJson?.card);
  const failed = runTickers.filter((row) => row.status === "failed");
  const forceDeterministic = Boolean(options?.forceDeterministic);
  const recoveryReason = options?.recoveryReason?.trim() || null;
  const runState = {
    id: run.id,
    provenanceJson: run.provenanceJson ?? null,
    providerUsageJson: run.providerUsageJson ?? null,
  };
  if (ready.length === 0) {
    await updateResearchRun(env, run.id, {
      status: failed.length > 0 ? "failed" : "completed",
      completedAt: nowIso(),
      completedTickerCount: 0,
      failedTickerCount: failed.length,
      errorSummary: failed.length > 0 ? "All ticker research jobs failed." : null,
    });
    return;
  }
  const runWarnings: string[] = [];
  const cards = ready.map((row) => row.workingJson?.card as StandardizedResearchCard);
  let marketEvidenceUsage: Record<string, unknown> | null = null;
  let rankingResponse: Awaited<ReturnType<typeof rankResearchCards>>;
  if (forceDeterministic) {
    const fallback = fallbackRankResearchCards({
      cards,
      rubric: profile.bundle.rubric.rubricJson,
      settings: profile.version.settings,
      deepDiveTopN: run.deepDiveTopN,
    });
    const deterministicWarning = recoveryReason ?? "Recovered stale ranking/finalization state and completed with deterministic ranking.";
    runWarnings.push(deterministicWarning);
    await persistRunActivity(env, runState, {
      message: deterministicWarning,
      level: "warn",
      currentStep: "Recovering stale ranking/finalization",
      warning: true,
    });
    rankingResponse = {
      ...fallback,
      usage: null,
      model: "rules-stale-finalize",
      warning: deterministicWarning,
    };
  } else {
    await persistRunActivity(env, runState, {
      message: `Finalizing research run for ${ready.length} ticker(s); collecting macro context and preparing ranking.`,
      currentStep: "Collecting macro context",
    });
    const marketEvidence = await collectMarketEvidence(env, {
      run,
      runTickers: ready,
      profile,
      touchHeartbeat: async () => {
        await updateResearchRunHeartbeat(env, run.id);
      },
    });
    marketEvidenceUsage = marketEvidence.usage;
    runState.providerUsageJson = sumUsage(runState.providerUsageJson, marketEvidenceUsage);
    await persistRunActivity(env, runState, {
      message: `Ranking ${cards.length} ready ticker(s).`,
      currentStep: "Ranking ready tickers",
    });
    rankingResponse = await runWithHeartbeat({
      touchHeartbeat: async () => {
        await updateResearchRunHeartbeat(env, run.id);
      },
      onHeartbeat: async (elapsedMs) => {
        await persistRunActivity(env, runState, {
          message: `Still waiting on ranking model (${formatElapsedLabel(elapsedMs)} elapsed).`,
          currentStep: `Ranking ready tickers (${formatElapsedLabel(elapsedMs)} elapsed)`,
        });
      },
      work: () => rankResearchCards(env, {
        cards,
        prompt: profile.bundle.sonnetRank,
        rubric: profile.bundle.rubric.rubricJson,
        settings: profile.version.settings,
        deepDiveTopN: run.deepDiveTopN,
      }),
    });
  }
  if (rankingResponse.warning) runWarnings.push(`Ranking fallback used: ${rankingResponse.warning}`);
  let aggregateUsage = sumUsage(run.providerUsageJson, sumUsage(marketEvidenceUsage, rankingResponse.usage));
  runState.providerUsageJson = aggregateUsage;
  await persistRunActivity(env, runState, {
    message: rankingResponse.warning
      ? `Ranking completed with fallback: ${rankingResponse.warning}`
      : `Ranking completed via ${rankingResponse.model}.`,
    level: rankingResponse.warning ? "warn" : "info",
    currentStep: run.rankingMode === "rank_and_deep_dive" && run.deepDiveTopN > 0 ? "Generating deep dives" : "Persisting ranked results",
    warning: Boolean(rankingResponse.warning),
  });
  const rankingByTicker = new Map(rankingResponse.rankings.map((row) => [row.ticker, row]));
  for (const row of ready) {
    const card = row.workingJson?.card as StandardizedResearchCard;
    const topicPackets = Array.isArray(row.workingJson?.topicPackets) ? row.workingJson?.topicPackets as TopicEvidencePacket[] : [];
    const peerContext = (row.workingJson?.peerContext ?? null) as PeerContextPacket | null;
    let rowStageMetrics = mergeJson(row.stageMetricsJson, {
      currentStage: "ranking_ready",
      currentStep: "Persisting ranked output",
      rankingModel: rankingResponse.model,
    });
    try {
      const factorCards = rankingResponse.factorCardsByTicker.get(row.ticker) ?? computeFactorCards(card, profile.bundle.rubric.rubricJson);
      const ranking = rankingByTicker.get(row.ticker) ?? {
        ticker: row.ticker,
        rank: 999,
        attentionScore: computeAttentionScore(factorCards),
        priorityBucket: derivePriorityBucket(computeAttentionScore(factorCards)),
        rankRationale: card.summary,
        scoreDeltaVsPrevious: null,
        deepDiveRequested: false,
      };
      rowStageMetrics = appendActivityPayload(mergeJson(rowStageMetrics, {
        currentStep: ranking.deepDiveRequested && run.rankingMode === "rank_and_deep_dive"
          ? "Generating deep dive"
          : "Persisting ranked snapshot",
        attentionRank: ranking.rank,
        attentionScore: ranking.attentionScore,
      }), {
        message: ranking.deepDiveRequested && run.rankingMode === "rank_and_deep_dive"
          ? `Selected for deep dive generation at rank ${ranking.rank}.`
          : `Persisting ranked output at rank ${ranking.rank}.`,
      });
      await updateResearchRunTicker(env, row.id, {
        status: ranking.deepDiveRequested && run.rankingMode === "rank_and_deep_dive" ? "deep_dive" : "ranking_ready",
        stageMetricsJson: rowStageMetrics,
      });
      await updateResearchRunHeartbeat(env, run.id);
      const deepDive = ranking.deepDiveRequested && run.rankingMode === "rank_and_deep_dive"
        ? forceDeterministic
          ? {
            deepDive: buildFallbackDeepDive(card),
            usage: null,
            model: "rules-stale-finalize",
            warning: recoveryReason ?? "Recovered stale finalization and completed deep dive deterministically.",
          }
          : await runWithHeartbeat({
            touchHeartbeat: async () => {
              await touchResearchHeartbeat(env, run.id, row.id);
            },
            onHeartbeat: async (elapsedMs) => {
              rowStageMetrics = appendActivityPayload(mergeJson(rowStageMetrics, {
                currentStage: "deep_dive",
                currentStep: `Waiting on deep-dive model (${formatElapsedLabel(elapsedMs)})`,
                deepDiveElapsedMs: elapsedMs,
              }), {
                message: `Still waiting on deep-dive model (${formatElapsedLabel(elapsedMs)} elapsed).`,
              });
              await updateResearchRunTicker(env, row.id, {
                status: "deep_dive",
                stageMetricsJson: rowStageMetrics,
              });
            },
            work: async () => deepDiveResearchCard(env, {
              card,
              prompt: profile.bundle.sonnetDeepDive,
              topicPackets,
              peerContext,
            }).catch(() => null),
          })
        : null;
      if (deepDive?.warning) runWarnings.push(`${row.ticker} deep-dive fallback used: ${deepDive.warning}`);
      aggregateUsage = sumUsage(aggregateUsage, deepDive?.usage ?? null);
      runState.providerUsageJson = aggregateUsage;
      const snapshot = await insertResearchSnapshot(env, {
        runId: run.id,
        runTickerId: row.id,
        ticker: row.ticker,
        profileId: run.profileId,
        profileVersionId: run.profileVersionId,
        previousSnapshotId: row.previousSnapshotId,
        overallScore: ranking.attentionScore,
        attentionRank: ranking.rank,
        confidenceLabel: card.confidenceLabel,
        confidenceScore: card.confidenceScore,
        valuationLabel: card.valuationView.label,
        earningsQualityLabel: card.earningsQuality.label,
        catalystFreshnessLabel: card.catalystFreshnessLabel,
        riskLabel: card.riskLabel,
        contradictionFlag: card.contradictions.length > 0,
        thesisJson: {
          ...card,
          companyName: row.companyName,
          deepDive: deepDive?.deepDive ?? null,
        },
        citationJson: {
          evidenceIds: card.topEvidenceIds,
          topicPackets,
          peerContext,
        },
        modelOutputJson: {
          extractionModel: card.model,
          rankingModel: rankingResponse.model,
          deepDiveModel: deepDive?.model ?? null,
        },
      });
      const previousSnapshot = row.previousSnapshotId ? await loadResearchSnapshot(env, row.previousSnapshotId) : null;
      const comparison = buildSnapshotComparison({
        currentSnapshot: snapshot,
        currentCard: card,
        previousSnapshot,
      });
      await env.DB.prepare(
        "UPDATE research_snapshots SET change_json = ? WHERE id = ?",
      ).bind(JSON.stringify(comparison), snapshot.id).run();
      for (const factor of factorCards) {
        await insertResearchFactor(env, {
          snapshotId: snapshot.id,
          ticker: row.ticker,
          factorKey: factor.key,
          score: factor.score,
          direction: factor.direction,
          confidenceScore: factor.confidenceScore,
          weightApplied: factor.weightApplied,
          explanationJson: { summary: factor.summary },
          supportingEvidenceIds: factor.evidenceIds,
        });
      }
      const rankingRow = await insertResearchRanking(env, {
        runId: run.id,
        snapshotId: snapshot.id,
        ticker: row.ticker,
        rank: ranking.rank,
        attentionScore: ranking.attentionScore,
        priorityBucket: ranking.priorityBucket,
        deepDiveRequested: ranking.deepDiveRequested,
        deepDiveCompleted: Boolean(deepDive),
        rankingJson: {
          rationale: ranking.rankRationale,
          scoreDeltaVsPrevious: ranking.scoreDeltaVsPrevious,
          convictionLevel: ranking.convictionLevel ?? null,
          relativeDifferentiation: ranking.relativeDifferentiation ?? null,
          deterministicBaseScore: ranking.deterministicBaseScore ?? null,
          deterministicAdjustmentNarrative: ranking.deterministicAdjustmentNarrative ?? null,
          peerImpactNarrative: ranking.peerImpactNarrative ?? null,
        },
      });
      rowStageMetrics = appendActivityPayload(mergeJson(rowStageMetrics, {
        currentStage: "completed",
        currentStep: "Completed",
        attentionRank: ranking.rank,
        attentionScore: ranking.attentionScore,
        deepDiveCompleted: Boolean(deepDive?.deepDive),
        deepDiveModel: deepDive?.model ?? null,
      }), {
        message: deepDive?.warning
          ? `Completed with deep-dive fallback: ${deepDive.warning}`
          : deepDive?.deepDive
            ? `Completed with deep dive via ${deepDive.model}.`
            : "Completed without deep dive.",
        level: deepDive?.warning ? "warn" : "info",
      });
      await updateResearchRunTicker(env, row.id, {
        status: "completed",
        snapshotId: snapshot.id,
        rankingRowId: rankingRow.id,
        completedAt: nowIso(),
        stageMetricsJson: rowStageMetrics,
        workingJson: {
          ...(row.workingJson ?? {}),
          comparison,
          ranking,
          deepDive: deepDive?.deepDive ?? null,
        },
      });
      await upsertTickerResearchHead(env, row.ticker, run.profileId, snapshot.id, run.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed while finalizing ranked output.";
      const failureMessage = `${row.ticker}: Finalization failed after ranking: ${message}`;
      runWarnings.push(failureMessage);
      rowStageMetrics = appendActivityPayload(mergeJson(rowStageMetrics, {
        currentStage: "failed",
        currentStep: "Failed while storing ranked output",
      }), {
        message: failureMessage,
        level: "error",
      });
      await updateResearchRunTicker(env, row.id, {
        status: "failed",
        lastError: failureMessage,
        completedAt: nowIso(),
        stageMetricsJson: rowStageMetrics,
      });
      await persistRunActivity(env, runState, {
        message: failureMessage,
        level: "error",
        currentStep: `Failure on ${row.ticker} during finalization`,
        warning: true,
      });
    }
  }
  runState.provenanceJson = mergeJson(runState.provenanceJson, { currentStep: "Completed" });
  const finalTickers = await loadResearchRunTickers(env, run.id);
  const finalFailed = finalTickers.filter((row) => row.status === "failed");
  const finalCompleted = finalTickers.filter((row) => row.status === "completed");
  await updateResearchRun(env, run.id, {
    status: finalFailed.length > 0 ? (finalCompleted.length > 0 ? "partial" : "failed") : "completed",
    providerUsageJson: aggregateUsage,
    provenanceJson: {
      ...(runState.provenanceJson ?? {}),
      warnings: Array.from(new Set([
        ...((((runState.provenanceJson as { warnings?: string[] } | null)?.warnings) ?? []) as string[]),
        ...runWarnings,
      ])),
    },
    completedAt: nowIso(),
    completedTickerCount: finalCompleted.length,
    failedTickerCount: finalFailed.length,
  });
}

async function resolveRunTickersFromRequest(env: Env, request: ResearchRunRequest): Promise<{ sourceId: string | null; sourceLabel: string | null; tickers: string[] }> {
  if (request.sourceType === "manual") {
    const tickers = Array.from(new Set((request.tickers ?? []).map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
    return {
      sourceId: request.sourceId ?? null,
      sourceLabel: request.sourceLabel ?? "Manual Research Run",
      tickers,
    };
  }
  const setId = request.sourceId?.trim();
  if (!setId) throw new Error("Watchlist set id is required for watchlist research.");
  const set = await loadWatchlistSet(env, setId);
  if (!set) throw new Error("Watchlist set not found.");
  const payload = request.sourceBasis === "compiled"
    ? await loadWatchlistCompiledRows(env, setId, request.watchlistRunId ?? null)
    : await loadWatchlistUniqueRows(env, setId, request.watchlistRunId ?? null);
  const rawTickers = (payload.rows ?? []).map((row: any) => String(row.ticker ?? "").trim().toUpperCase()).filter(Boolean);
  const allowed = new Set((request.selectedTickers ?? []).map((ticker) => ticker.trim().toUpperCase()).filter(Boolean));
  const tickers = Array.from(new Set(rawTickers.filter((ticker) => allowed.size === 0 || allowed.has(ticker))));
  return {
    sourceId: set.id,
    sourceLabel: set.name,
    tickers,
  };
}

export async function startResearchRun(env: Env, request: ResearchRunRequest): Promise<ResearchRunRecord> {
  const profile = await resolveResearchProfile(env, request.profileId);
  const resolved = await resolveRunTickersFromRequest(env, request);
  const maxTickers = request.maxTickers ?? profile.version.settings.maxTickersPerRun;
  const tickers = resolved.tickers.slice(0, maxTickers);
  if (tickers.length === 0) throw new Error("No tickers available for research.");
  const run = await createResearchRun(env, {
    request,
    profile,
    sourceType: request.sourceType,
    sourceId: resolved.sourceId,
    sourceLabel: request.sourceLabel ?? resolved.sourceLabel,
    tickers,
    deepDiveTopN: request.rankingMode === "rank_and_deep_dive"
      ? Math.max(0, Math.min(request.deepDiveTopN ?? profile.version.settings.deepDiveTopN, tickers.length))
      : 0,
    refreshMode: request.refreshMode ?? "reuse_fresh_search_cache",
    rankingMode: request.rankingMode ?? "rank_only",
  });
  return (await loadResearchRun(env, run.id)) ?? run;
}

export async function advanceResearchRun(env: Env, runId: string, maxTickers = DEFAULT_RESEARCH_SLICE_TICKERS): Promise<ResearchRunRecord | null> {
  const run = await loadResearchRun(env, runId);
  if (!run) return null;
  if (run.status === "completed" || run.status === "partial" || run.status === "failed" || run.status === "cancelled") return run;
  const executionRun = await tryAcquireResearchRunExecution(env, run.id, RESEARCH_EXECUTION_STALE_SECONDS);
  if (!executionRun) return loadResearchRun(env, run.id);
  const runState = {
    id: executionRun.id,
    provenanceJson: executionRun.provenanceJson ?? null,
    providerUsageJson: executionRun.providerUsageJson ?? null,
  };
  const staleEvents = await recoverStaleInProgressTickers(env, run.id);
  for (const event of staleEvents) {
    await persistRunActivity(env, runState, {
      message: event.message,
      level: event.level,
      currentStep: "Recovering stale ticker state",
      warning: true,
    });
  }
  let usage = executionRun.providerUsageJson;
  runState.providerUsageJson = usage;
  const runWarnings = new Set<string>((runState.provenanceJson as { warnings?: string[] } | null)?.warnings ?? []);
  for (let index = 0; index < maxTickers; index += 1) {
    const latestRun = await loadResearchRun(env, run.id);
    if (!latestRun || latestRun.status === "cancelled") break;
    const nextTicker = await claimNextRunnableResearchTicker(env, run.id);
    if (!nextTicker) break;
    const claimedRun = await loadResearchRun(env, run.id);
    if (!claimedRun || claimedRun.status === "cancelled") {
      await updateResearchRunTicker(env, nextTicker.id, {
        status: "cancelled",
        lastError: "Cancelled by user.",
        completedAt: nowIso(),
      });
      break;
    }
    await persistRunActivity(env, runState, {
      message: `Processing ${nextTicker.ticker} (attempt ${nextTicker.attemptCount + 1}/${RESEARCH_MAX_TICKER_ATTEMPTS}).`,
      currentStep: `Processing ${nextTicker.ticker}`,
    });
    await touchResearchHeartbeat(env, run.id, nextTicker.id);
    try {
      const result = await processResearchTicker(env, executionRun, nextTicker);
      usage = sumUsage(usage, result.usage);
      runState.providerUsageJson = usage;
      result.warnings.forEach((warning) => runWarnings.add(warning));
      await persistRunActivity(env, runState, {
        message: `${nextTicker.ticker} reached ranking with ${result.warnings.length} warning(s).`,
        level: result.warnings.length > 0 ? "warn" : "info",
        currentStep: `Queued ${nextTicker.ticker} for ranking`,
        warning: result.warnings.length > 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ticker research failed.";
      runWarnings.add(`${nextTicker.ticker} failed: ${message}`);
      await updateResearchRunTicker(env, nextTicker.id, {
        status: "failed",
        lastError: message,
        completedAt: nowIso(),
      });
      await persistRunActivity(env, runState, {
        message: `${nextTicker.ticker} failed: ${message}`,
        level: "error",
        currentStep: `Failure on ${nextTicker.ticker}`,
        warning: true,
      });
    }
  }
  const counts = await countRunTickerStatuses(env, run.id);
  const totalProcessed = counts.completed + counts.failed + counts.rankingReady;
  runState.provenanceJson = mergeJson(runState.provenanceJson, {
    currentStep: counts.rankingReady > 0 && counts.queued === 0 && counts.inProgress === 0
      ? "Finalizing ranked results"
      : counts.inProgress > 0
        ? "Ticker processing in progress"
        : "Awaiting remaining tickers",
  });
  await updateResearchRun(env, run.id, {
    providerUsageJson: runState.providerUsageJson,
    provenanceJson: {
      ...(runState.provenanceJson ?? {}),
      warnings: Array.from(runWarnings),
    },
    completedTickerCount: counts.completed,
    failedTickerCount: counts.failed,
  });
  const refreshed = await loadResearchRun(env, run.id);
  if (!refreshed) return null;
  if (refreshed.status === "cancelled") return refreshed;
  if (counts.queued === 0 && counts.inProgress === 0 && counts.rankingReady > 0) {
    await finalizeResearchRun(env, refreshed);
    return loadResearchRun(env, run.id);
  }
  if (counts.queued === 0 && counts.inProgress === 0 && totalProcessed >= refreshed.requestedTickerCount && counts.rankingReady === 0) {
    await finalizeResearchRun(env, refreshed);
    return loadResearchRun(env, run.id);
  }
  return refreshed;
}

export async function drainResearchRun(env: Env, runId: string, maxPasses = 24): Promise<ResearchRunRecord | null> {
  let latest: ResearchRunRecord | null = null;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    latest = await advanceResearchRun(env, runId, DEFAULT_RESEARCH_SLICE_TICKERS);
    if (!latest) return null;
    if (["completed", "partial", "failed", "cancelled"].includes(latest.status)) return latest;
    await scheduler.wait(750);
  }
  return latest;
}

function parseHeartbeatMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function formatElapsedLabel(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

async function runWithHeartbeat<T>(input: {
  work: () => Promise<T>;
  touchHeartbeat: () => Promise<void>;
  heartbeatEveryMs?: number;
  onHeartbeat?: (elapsedMs: number, beatCount: number) => Promise<void>;
}): Promise<T> {
  const heartbeatEveryMs = Math.max(10_000, input.heartbeatEveryMs ?? 15_000);
  const startedAt = Date.now();
  let beatCount = 0;
  const workPromise = input.work();
  await input.touchHeartbeat();
  while (true) {
    const raced = await Promise.race([
      workPromise.then((value) => ({ done: true as const, value })),
      scheduler.wait(heartbeatEveryMs).then(() => ({ done: false as const })),
    ]);
    if (raced.done) {
      return raced.value;
    }
    beatCount += 1;
    try {
      await input.touchHeartbeat();
      await input.onHeartbeat?.(Date.now() - startedAt, beatCount);
    } catch {
      // Best-effort keepalive; terminal failures surface through the wrapped work.
    }
  }
}

async function recoverStaleInProgressTickers(env: Env, runId: string): Promise<Array<{ level: ResearchActivityLevel; message: string }>> {
  const tickers = await loadResearchRunTickers(env, runId);
  const nowMs = Date.now();
  const events: Array<{ level: ResearchActivityLevel; message: string }> = [];
  for (const ticker of tickers) {
    if (!["normalizing", "retrieving", "extracting", "deep_dive"].includes(ticker.status)) continue;
    const heartbeatMs = parseHeartbeatMs(ticker.heartbeatAt ?? ticker.updatedAt ?? ticker.startedAt ?? ticker.createdAt);
    if (heartbeatMs !== null && nowMs - heartbeatMs < RESEARCH_HEARTBEAT_STALE_MS) continue;
    const heartbeatAgeMs = heartbeatMs === null ? RESEARCH_HEARTBEAT_STALE_MS : Math.max(0, nowMs - heartbeatMs);
    if (ticker.status === "deep_dive") {
      const deepDiveRetryCount = typeof ticker.stageMetricsJson?.deepDiveRetryCount === "number"
        ? Number(ticker.stageMetricsJson.deepDiveRetryCount)
        : 0;
      if (deepDiveRetryCount >= 2) {
        const message = `Deep-dive generation became stale after ${formatElapsedLabel(heartbeatAgeMs)} without a heartbeat and exceeded the retry limit (${deepDiveRetryCount}/2).`;
        await updateResearchRunTicker(env, ticker.id, {
          status: "failed",
          lastError: message,
          completedAt: nowIso(),
          stageMetricsJson: appendActivityPayload(mergeJson(ticker.stageMetricsJson, {
            currentStage: "failed",
            currentStep: "Failed after stale deep-dive recovery attempts",
            staleHeartbeatAgeMs: heartbeatAgeMs,
            deepDiveRetryCount,
          }), {
            message,
            level: "error",
          }),
        });
        events.push({ level: "error", message: `${ticker.ticker}: ${message}` });
        continue;
      }
      const message = `Recovered stale deep-dive state after ${formatElapsedLabel(heartbeatAgeMs)} without a heartbeat; retrying deep dive (${deepDiveRetryCount + 1}/2).`;
      await updateResearchRunTicker(env, ticker.id, {
        status: "ranking_ready",
        lastError: message,
        completedAt: null,
        stageMetricsJson: appendActivityPayload(mergeJson(ticker.stageMetricsJson, {
          currentStage: "ranking_ready",
          currentStep: "Queued for deep-dive retry after stale recovery",
          staleHeartbeatAgeMs: heartbeatAgeMs,
          deepDiveRetryCount: deepDiveRetryCount + 1,
        }), {
          message,
          level: "warn",
        }),
      });
      events.push({ level: "warn", message: `${ticker.ticker}: ${message}` });
      continue;
    }
    if (ticker.status === "extracting") {
      const evidence = await loadRunTickerEvidence(env, ticker.id);
      if (evidence.length > 0) {
        const workingJson = mergeJson(ticker.workingJson, {});
        const topicPackets = Array.isArray(workingJson.topicPackets)
          ? workingJson.topicPackets as TopicEvidencePacket[]
          : buildTopicEvidencePackets(evidence, {
            lookbackDays: 14,
            includeMacroContext: true,
            maxTickerQueries: 4,
            maxEvidenceItemsPerTicker: 12,
            maxSearchResultsPerQuery: 4,
            maxTickersPerRun: 20,
            deepDiveTopN: 3,
            comparisonEnabled: true,
            peerComparisonEnabled: true,
            maxPeerCandidates: 3,
            maxTopicEvidenceItems: 4,
            maxEvidenceExcerptsPerTopic: 2,
            sourceFamilies: {
              sec: true,
              news: true,
              earningsTranscripts: true,
              investorRelations: true,
              analystCommentary: true,
            },
          });
        const peerContext = (workingJson.peerContext ?? {
          available: false,
          confidence: "low",
          reasonUnavailable: "Peer context was unavailable when stale extraction fallback ran.",
          peerGroupId: null,
          peerGroupName: null,
          source: "none",
          whyTheseAreClosestPeers: "",
          closestPeers: [],
        }) as PeerContextPacket;
        const companyName = typeof ticker.companyName === "string" && ticker.companyName.trim()
          ? ticker.companyName
          : evidence.find((item) => item.ticker?.toUpperCase() === ticker.ticker)?.ticker ?? null;
        const fallbackCard = fallbackExtractResearchCard({
          ticker: ticker.ticker,
          companyName,
          evidence,
          peerContext,
          topicPackets,
        });
        const message = `Recovered stale extracting state after ${formatElapsedLabel(heartbeatAgeMs)} without a heartbeat; completed extraction via deterministic fallback instead of retrying the same attempt.`;
        await updateResearchRunTicker(env, ticker.id, {
          status: "ranking_ready",
          lastError: message,
          completedAt: null,
          workingJson: {
            ...workingJson,
            card: {
              ...fallbackCard,
              reasoningBullets: [
                ...fallbackCard.reasoningBullets,
                "Stale extraction recovery used deterministic fallback synthesis from stored evidence.",
              ].slice(0, 4),
            },
            extractionModel: "rules-stale-fallback",
            warnings: Array.from(new Set([
              ...(
                Array.isArray(workingJson.warnings)
                  ? workingJson.warnings.map((item) => String(item ?? "").trim()).filter(Boolean)
                  : []
              ),
              message,
            ])),
            topicPackets,
            peerContext,
          },
          stageMetricsJson: appendActivityPayload(mergeJson(ticker.stageMetricsJson, {
            currentStage: "ranking_ready",
            currentStep: "Recovered stale extraction via deterministic fallback",
            staleHeartbeatAgeMs: heartbeatAgeMs,
            extractionRecoveredViaFallback: true,
          }), {
            message,
            level: "warn",
          }),
        });
        events.push({ level: "warn", message: `${ticker.ticker}: ${message}` });
        continue;
      }
    }
    if (ticker.attemptCount >= RESEARCH_MAX_TICKER_ATTEMPTS) {
      const message = buildStaleFailureMessage(ticker.status, heartbeatAgeMs, ticker.attemptCount, RESEARCH_MAX_TICKER_ATTEMPTS);
      await updateResearchRunTicker(env, ticker.id, {
        status: "failed",
        lastError: message,
        completedAt: nowIso(),
        stageMetricsJson: appendActivityPayload(mergeJson(ticker.stageMetricsJson, {
          currentStage: "failed",
          currentStep: "Failed after stale recovery attempts",
          staleHeartbeatAgeMs: heartbeatAgeMs,
          maxAttempts: RESEARCH_MAX_TICKER_ATTEMPTS,
        }), {
          message,
          level: "error",
        }),
      });
      events.push({ level: "error", message: `${ticker.ticker}: ${message}` });
      continue;
    }
    const message = buildStaleRecoveryMessage(ticker.status, heartbeatAgeMs, ticker.attemptCount, RESEARCH_MAX_TICKER_ATTEMPTS);
    await updateResearchRunTicker(env, ticker.id, {
      status: "queued",
      lastError: message,
      completedAt: null,
      stageMetricsJson: appendActivityPayload(mergeJson(ticker.stageMetricsJson, {
        currentStage: "queued",
        currentStep: "Queued for retry after stale recovery",
        staleHeartbeatAgeMs: heartbeatAgeMs,
        maxAttempts: RESEARCH_MAX_TICKER_ATTEMPTS,
      }), {
        message,
        level: "warn",
      }),
    });
    events.push({ level: "warn", message: `${ticker.ticker}: ${message}` });
  }
  return events;
}

export async function ensureResearchRunProgress(env: Env, runId: string): Promise<ResearchRunRecord | null> {
  const run = await loadResearchRun(env, runId);
  if (!run) return null;
  if (run.status === "completed" || run.status === "partial" || run.status === "failed" || run.status === "cancelled") {
    return run;
  }

  if (run.status === "queued") {
    return drainResearchRun(env, runId);
  }

  const counts = await countRunTickerStatuses(env, runId);
  const heartbeatMs = parseHeartbeatMs(run.heartbeatAt ?? run.updatedAt ?? run.startedAt ?? run.createdAt);
  const nowMs = Date.now();
  const heartbeatAgeMs = heartbeatMs === null ? RESEARCH_HEARTBEAT_STALE_MS : Math.max(0, nowMs - heartbeatMs);
  if (heartbeatMs === null || heartbeatAgeMs >= RESEARCH_HEARTBEAT_STALE_MS) {
    if (counts.queued === 0 && counts.inProgress === 0 && counts.rankingReady > 0) {
      const recoveryReason = `Recovered stale ranking/finalization state after ${formatElapsedLabel(heartbeatAgeMs)} without a heartbeat; completed ranking${run.rankingMode === "rank_and_deep_dive" && run.deepDiveTopN > 0 ? " and requested deep dives" : ""} via deterministic fallback instead of retrying the same finalization attempt.`;
      await finalizeResearchRun(env, run, {
        forceDeterministic: true,
        recoveryReason,
      });
      return loadResearchRun(env, runId);
    }
    return drainResearchRun(env, runId);
  }

  const idleButRunnable = counts.inProgress === 0 && (
    counts.queued > 0
    || (counts.rankingReady > 0 && (await loadRunRankings(env, runId)).length === 0)
  );
  if (idleButRunnable) {
    return drainResearchRun(env, runId, Math.max(24, Math.ceil(RESEARCH_HEARTBEAT_STALE_MS / 750) + 8));
  }

  return run;
}

export async function advanceResearchQueue(env: Env, limitRuns = 2): Promise<void> {
  const runs = await listQueuedResearchRuns(env, limitRuns);
  for (const run of runs) {
    await advanceResearchRun(env, run.id, DEFAULT_RESEARCH_SLICE_TICKERS);
  }
}

export { cancelResearchRun };
