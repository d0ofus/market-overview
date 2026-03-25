import type { Env } from "../types";
import { DEFAULT_RESEARCH_SLICE_TICKERS, RESEARCH_HEARTBEAT_STALE_MS } from "./constants";
import { searchItemsToEvidence, secFactsToEvidence, secFilingsToEvidence } from "./evidence";
import { extractResearchCard } from "./extraction";
import { buildSnapshotComparison } from "./history";
import { resolveResearchProfile } from "./profiles";
import { getSearchResearchProvider, getSecResearchProvider } from "./providers";
import { buildMarketSearchQueries, buildTickerSearchQueries } from "./search-queries";
import { computeFactorCards, computeAttentionScore, derivePriorityBucket } from "./scoring";
import { normalizeResearchTicker } from "./sec-normalization";
import { deepDiveResearchCard, rankResearchCards } from "./synthesis";
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
  upsertTickerResearchHead,
} from "./storage";
import type {
  ResearchEvidenceRecord,
  ResearchRunRecord,
  ResearchRunRequest,
  ResearchRunTickerRecord,
  StandardizedResearchCard,
} from "./types";
import { loadWatchlistCompiledRows, loadWatchlistUniqueRows, loadWatchlistSet } from "../watchlist-compiler-service";

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

async function collectTickerEvidence(env: Env, input: {
  run: ResearchRunRecord;
  runTicker: ResearchRunTickerRecord;
  companyName: string | null;
  secCik: string | null;
  irDomain: string | null;
  profile: Awaited<ReturnType<typeof resolveResearchProfile>>;
  touchHeartbeat?: () => Promise<void>;
}): Promise<{ evidence: ResearchEvidenceRecord[]; usage: Record<string, unknown> | null; warnings: string[] }> {
  const secProvider = getSecResearchProvider(env);
  const searchProvider = getSearchResearchProvider(env);
  const evidence: ResearchEvidenceRecord[] = [];
  let usage: Record<string, unknown> | null = null;
  const warnings: string[] = [];

  if (input.profile.version.settings.sourceFamilies.sec && input.secCik) {
    await input.touchHeartbeat?.();
    const [filings, facts] = await Promise.all([
      secProvider.fetchRecentFilings(input.secCik, env).catch(() => []),
      secProvider.fetchStructuredFacts(input.secCik, env).catch(() => []),
    ]);
    const secEvidence = [
      ...secFilingsToEvidence(input.runTicker.ticker, input.secCik, filings),
      ...secFactsToEvidence(input.runTicker.ticker, input.secCik, facts),
    ];
    for (const [index, item] of secEvidence.entries()) {
      const stored = await insertResearchEvidence(env, item);
      await linkResearchEvidence(env, input.run.id, input.runTicker.id, stored.id, "primary", index + 1);
      evidence.push(stored);
    }
  } else if (input.profile.version.settings.sourceFamilies.sec) {
    warnings.push("SEC issuer mapping was unavailable for this ticker.");
  }

  const queries = buildTickerSearchQueries({
    ticker: input.runTicker.ticker,
    companyName: input.companyName,
    irDomain: input.irDomain,
    template: input.profile.bundle.searchTemplate,
    settings: input.profile.version.settings,
  });
  for (const query of queries) {
    try {
      await input.touchHeartbeat?.();
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
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : `Search query ${query.key} failed.`);
    }
  }

  return { evidence, usage, warnings };
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
  const touchHeartbeat = async () => {
    await updateResearchRunHeartbeat(env, run.id);
  };
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
  });
  const collected = await collectTickerEvidence(env, {
    run,
    runTicker,
    companyName: normalized.companyName,
    secCik: normalized.secCik,
    irDomain: normalized.irDomain,
    profile,
    touchHeartbeat,
  });
  await touchHeartbeat();
  await updateResearchRunTicker(env, runTicker.id, {
    status: "extracting",
    stageMetricsJson: {
      evidenceCount: collected.evidence.length,
      warningCount: collected.warnings.length,
    },
  });
  const extracted = await extractResearchCard(env, {
    ticker: runTicker.ticker,
    companyName: normalized.companyName,
    evidence: collected.evidence,
    prompt: profile.bundle.haiku,
  });
  const warnings = extracted.warning ? [...collected.warnings, extracted.warning] : collected.warnings;
  await updateResearchRunTicker(env, runTicker.id, {
    status: "ranking_ready",
    workingJson: {
      card: extracted.card,
      extractionModel: extracted.model,
      warnings,
    },
    stageMetricsJson: {
      evidenceCount: collected.evidence.length,
      warningCount: warnings.length,
      extractionUsage: extracted.usage,
    },
  });
  return {
    usage: sumUsage(collected.usage, extracted.usage),
    warnings,
  };
}

async function finalizeResearchRun(env: Env, run: ResearchRunRecord): Promise<void> {
  const profile = await resolveResearchProfile(env, run.profileId);
  const runTickers = await loadResearchRunTickers(env, run.id);
  const ready = runTickers.filter((row) => row.status === "ranking_ready" && row.workingJson?.card);
  const failed = runTickers.filter((row) => row.status === "failed");
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
  const marketEvidence = await collectMarketEvidence(env, {
    run,
    runTickers: ready,
    profile,
    touchHeartbeat: async () => {
      await updateResearchRunHeartbeat(env, run.id);
    },
  });
  const runWarnings: string[] = [];
  const cards = ready.map((row) => row.workingJson?.card as StandardizedResearchCard);
  const rankingResponse = await rankResearchCards(env, {
    cards,
    prompt: profile.bundle.sonnetRank,
    rubric: profile.bundle.rubric.rubricJson,
    settings: profile.version.settings,
    deepDiveTopN: run.deepDiveTopN,
  });
  if (rankingResponse.warning) runWarnings.push(`Ranking fallback used: ${rankingResponse.warning}`);
  let aggregateUsage = sumUsage(run.providerUsageJson, sumUsage(marketEvidence.usage, rankingResponse.usage));
  const rankingByTicker = new Map(rankingResponse.rankings.map((row) => [row.ticker, row]));
  for (const row of ready) {
    const card = row.workingJson?.card as StandardizedResearchCard;
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
    const deepDive = ranking.deepDiveRequested && run.rankingMode === "rank_and_deep_dive"
      ? await deepDiveResearchCard(env, { card, prompt: profile.bundle.sonnetDeepDive }).catch(() => null)
      : null;
    if (deepDive?.warning) runWarnings.push(`${row.ticker} deep-dive fallback used: ${deepDive.warning}`);
    aggregateUsage = sumUsage(aggregateUsage, deepDive?.usage ?? null);
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
      valuationLabel: card.valuation.label,
      earningsQualityLabel: card.earningsQuality.label,
      catalystFreshnessLabel: card.catalystFreshnessLabel,
      riskLabel: card.riskLabel,
      contradictionFlag: card.contradictions.length > 0,
      thesisJson: {
        companyName: row.companyName,
        summary: card.summary,
        valuation: card.valuation,
        earningsQuality: card.earningsQuality,
        catalysts: card.catalysts,
        risks: card.risks,
        contradictions: card.contradictions,
        reasoningBullets: card.reasoningBullets,
        deepDive: deepDive?.deepDive ?? null,
      },
      citationJson: {
        evidenceIds: card.topEvidenceIds,
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
      },
    });
    await updateResearchRunTicker(env, row.id, {
      status: "completed",
      snapshotId: snapshot.id,
      rankingRowId: rankingRow.id,
      completedAt: nowIso(),
      workingJson: {
        ...(row.workingJson ?? {}),
        comparison,
        ranking,
        deepDive: deepDive?.deepDive ?? null,
      },
    });
    await upsertTickerResearchHead(env, row.ticker, run.profileId, snapshot.id, run.id);
  }
  await updateResearchRun(env, run.id, {
    status: failed.length > 0 ? "partial" : "completed",
    providerUsageJson: aggregateUsage,
    provenanceJson: {
      ...(run.provenanceJson ?? {}),
      warnings: Array.from(new Set([
        ...(((run.provenanceJson as { warnings?: string[] } | null)?.warnings) ?? []),
        ...runWarnings,
      ])),
    },
    completedAt: nowIso(),
    completedTickerCount: ready.length,
    failedTickerCount: failed.length,
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
  const executionRun = await tryAcquireResearchRunExecution(env, run.id);
  if (!executionRun) return loadResearchRun(env, run.id);
  let usage = executionRun.providerUsageJson;
  const runWarnings = new Set<string>((executionRun.provenanceJson as { warnings?: string[] } | null)?.warnings ?? []);
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
    await updateResearchRunHeartbeat(env, run.id);
    try {
      const result = await processResearchTicker(env, executionRun, nextTicker);
      usage = sumUsage(usage, result.usage);
      result.warnings.forEach((warning) => runWarnings.add(warning));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ticker research failed.";
      runWarnings.add(`${nextTicker.ticker} failed: ${message}`);
      await updateResearchRunTicker(env, nextTicker.id, {
        status: "failed",
        lastError: message,
        completedAt: nowIso(),
      });
    }
  }
  const counts = await countRunTickerStatuses(env, run.id);
  const totalProcessed = counts.completed + counts.failed + counts.rankingReady;
  await updateResearchRun(env, run.id, {
    providerUsageJson: usage,
    provenanceJson: {
      ...(run.provenanceJson ?? {}),
      warnings: Array.from(runWarnings),
    },
    completedTickerCount: counts.completed,
    failedTickerCount: counts.failed,
  });
  const refreshed = await loadResearchRun(env, run.id);
  if (!refreshed) return null;
  if (refreshed.status === "cancelled") return refreshed;
  if (counts.queued === 0 && counts.inProgress === 0 && counts.rankingReady > 0 && (await loadRunRankings(env, run.id)).length === 0) {
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

export async function ensureResearchRunProgress(env: Env, runId: string): Promise<ResearchRunRecord | null> {
  const run = await loadResearchRun(env, runId);
  if (!run) return null;
  if (run.status === "completed" || run.status === "partial" || run.status === "failed" || run.status === "cancelled") {
    return run;
  }

  if (run.status === "queued") {
    return drainResearchRun(env, runId);
  }

  const heartbeatMs = parseHeartbeatMs(run.heartbeatAt ?? run.updatedAt ?? run.startedAt ?? run.createdAt);
  const nowMs = Date.now();
  if (heartbeatMs === null || nowMs - heartbeatMs >= RESEARCH_HEARTBEAT_STALE_MS) {
    return drainResearchRun(env, runId);
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
