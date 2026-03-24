import type { Env } from "../types";
import { listResearchProfiles } from "./profiles";
import {
  loadResearchRun,
  loadResearchRunTickers,
  loadResearchSnapshot,
  loadResearchSnapshotEvidence,
  loadResearchSnapshotFactors,
  loadRunRankings,
  loadTickerResearchHistory,
} from "./storage";
import { buildSnapshotComparison } from "./history";
import type { ResearchRunResultsResponse, ResearchRunStatusResponse, ResearchTickerResult } from "./types";

export async function loadResearchRunStatusPayload(env: Env, runId: string): Promise<ResearchRunStatusResponse | null> {
  const [run, profiles, tickers] = await Promise.all([
    loadResearchRun(env, runId),
    listResearchProfiles(env),
    loadResearchRunTickers(env, runId),
  ]);
  if (!run) return null;
  return {
    run,
    profile: profiles.find((profile) => profile.id === run.profileId) ?? null,
    tickers,
  };
}

async function buildTickerResult(env: Env, snapshotId: string): Promise<ResearchTickerResult | null> {
  const snapshot = await loadResearchSnapshot(env, snapshotId);
  if (!snapshot) return null;
  const evidence = await loadResearchSnapshotEvidence(env, snapshotId);
  const thesis = snapshot.thesisJson as Record<string, any>;
  const citationIds = Array.isArray((snapshot.citationJson as any)?.evidenceIds)
    ? ((snapshot.citationJson as any).evidenceIds as string[])
    : [];
  const citations = citationIds.map((evidenceId) => evidence.find((item) => item.id === evidenceId)).filter(Boolean).map((item) => ({
    evidenceId: item!.id,
    title: item!.title,
    url: item!.canonicalUrl,
    sourceDomain: item!.sourceDomain,
    publishedAt: item!.publishedAt,
  }));
  return {
    snapshotId: snapshot.id,
    ticker: snapshot.ticker,
    companyName: (thesis.companyName as string | null | undefined) ?? null,
    overallScore: snapshot.overallScore,
    attentionRank: snapshot.attentionRank,
    confidenceLabel: snapshot.confidenceLabel,
    confidenceScore: snapshot.confidenceScore,
    valuationLabel: snapshot.valuationLabel,
    earningsQualityLabel: snapshot.earningsQualityLabel,
    catalystFreshnessLabel: snapshot.catalystFreshnessLabel,
    riskLabel: snapshot.riskLabel,
    contradictionFlag: snapshot.contradictionFlag,
    summary: String(thesis.summary ?? ""),
    catalysts: Array.isArray(thesis.catalysts) ? thesis.catalysts : [],
    risks: Array.isArray(thesis.risks) ? thesis.risks : [],
    changeSummary: typeof (snapshot.changeJson as any)?.summary === "string" ? (snapshot.changeJson as any).summary : null,
    citations,
  };
}

export async function loadResearchRunResultsPayload(env: Env, runId: string): Promise<ResearchRunResultsResponse | null> {
  const [status, rankings] = await Promise.all([
    loadResearchRunStatusPayload(env, runId),
    loadRunRankings(env, runId),
  ]);
  if (!status) return null;
  const results: ResearchTickerResult[] = [];
  for (const ranking of rankings) {
    const result = await buildTickerResult(env, ranking.snapshotId);
    if (result) results.push(result);
  }
  return {
    run: status.run,
    profile: status.profile,
    results,
    providerUsage: status.run.providerUsageJson,
    warnings: Array.isArray((status.run.provenanceJson as any)?.warnings) ? (status.run.provenanceJson as any).warnings : [],
  };
}

export async function loadResearchSnapshotDetailPayload(env: Env, snapshotId: string): Promise<{
  snapshot: any;
  factors: any[];
  evidence: any[];
} | null> {
  const [snapshot, factors, evidence] = await Promise.all([
    loadResearchSnapshot(env, snapshotId),
    loadResearchSnapshotFactors(env, snapshotId),
    loadResearchSnapshotEvidence(env, snapshotId),
  ]);
  if (!snapshot) return null;
  return {
    snapshot,
    factors,
    evidence,
  };
}

export async function loadResearchSnapshotComparePayload(env: Env, snapshotId: string, baselineSnapshotId?: string | null) {
  const current = await loadResearchSnapshot(env, snapshotId);
  if (!current) return null;
  const previous = baselineSnapshotId ? await loadResearchSnapshot(env, baselineSnapshotId) : current.previousSnapshotId ? await loadResearchSnapshot(env, current.previousSnapshotId) : null;
  const thesis = current.thesisJson as Record<string, any>;
  return buildSnapshotComparison({
    currentSnapshot: current,
    currentCard: {
      ticker: current.ticker,
      companyName: thesis.companyName ?? null,
      summary: thesis.summary ?? "",
      valuation: thesis.valuation ?? { label: "unclear", summary: "" },
      earningsQuality: thesis.earningsQuality ?? { label: "unclear", summary: "" },
      catalysts: Array.isArray(thesis.catalysts) ? thesis.catalysts : [],
      risks: Array.isArray(thesis.risks) ? thesis.risks : [],
      contradictions: Array.isArray(thesis.contradictions) ? thesis.contradictions : [],
      confidenceScore: current.confidenceScore ?? 0,
      confidenceLabel: current.confidenceLabel ?? "low",
      catalystFreshnessLabel: current.catalystFreshnessLabel ?? "unclear",
      riskLabel: current.riskLabel ?? "moderate",
      factorCards: [],
      topEvidenceIds: Array.isArray((current.citationJson as any)?.evidenceIds) ? (current.citationJson as any).evidenceIds : [],
      valuationScore: current.overallScore ?? 0,
      earningsQualityScore: current.overallScore ?? 0,
      catalystQualityScore: current.overallScore ?? 0,
      catalystFreshnessScore: current.overallScore ?? 0,
      riskScore: current.overallScore ?? 0,
      contradictionScore: 70,
      model: "snapshot",
      reasoningBullets: [],
    },
    previousSnapshot: previous,
  });
}

export async function loadTickerResearchHistoryPayload(env: Env, ticker: string, profileId?: string | null) {
  return loadTickerResearchHistory(env, ticker, profileId);
}
