import type { Env } from "../types";
import { RESEARCH_LAB_RESULTS_EVENT_LIMIT } from "./constants";
import {
  loadResearchLabProfile,
  loadResearchLabProfileVersion,
} from "./profiles";
import {
  loadResearchLabEvidenceForRun,
  loadResearchLabEvidenceProfile,
  loadResearchLabOutputsForRun,
  loadResearchLabPromptConfig,
  loadResearchLabRun,
  loadResearchLabRunEvents,
  loadResearchLabRunItems,
  loadResearchLabTickerHistory,
} from "./storage";
import type {
  ResearchLabRunResultsResponse,
  ResearchLabRunStatusResponse,
} from "./types";

export async function loadResearchLabRunStatusPayload(
  env: Env,
  runId: string,
): Promise<ResearchLabRunStatusResponse | null> {
  const run = await loadResearchLabRun(env, runId);
  if (!run) return null;
  const [items, events, profile, profileVersion, promptConfig, evidenceProfile] = await Promise.all([
    loadResearchLabRunItems(env, runId),
    loadResearchLabRunEvents(env, runId, RESEARCH_LAB_RESULTS_EVENT_LIMIT),
    run.profileId ? loadResearchLabProfile(env, run.profileId) : null,
    run.profileVersionId ? loadResearchLabProfileVersion(env, run.profileVersionId) : null,
    run.promptConfigId ? loadResearchLabPromptConfig(env, run.promptConfigId) : loadResearchLabPromptConfig(env, null),
    run.evidenceProfileId ? loadResearchLabEvidenceProfile(env, run.evidenceProfileId) : loadResearchLabEvidenceProfile(env, null),
  ]);
  return {
    run,
    items,
    events,
    profile,
    profileVersion,
    promptConfig,
    evidenceProfile,
  };
}

export async function loadResearchLabRunResultsPayload(
  env: Env,
  runId: string,
): Promise<ResearchLabRunResultsResponse | null> {
  const status = await loadResearchLabRunStatusPayload(env, runId);
  if (!status) return null;
  const [evidenceRows, outputRows] = await Promise.all([
    loadResearchLabEvidenceForRun(env, runId),
    loadResearchLabOutputsForRun(env, runId),
  ]);
  const evidenceByItem = new Map<string, typeof evidenceRows>();
  for (const row of evidenceRows) {
    const current = evidenceByItem.get(row.runItemId) ?? [];
    current.push(row);
    evidenceByItem.set(row.runItemId, current);
  }
  const outputByItem = new Map(outputRows.map((row) => [row.runItemId, row]));
  const items = status.items.map((item) => ({
    item,
    events: status.events.filter((event) => event.runItemId === item.id),
    evidence: evidenceByItem.get(item.id) ?? [],
    output: outputByItem.get(item.id) ?? null,
  }));
  return {
    run: status.run,
    items,
    profile: status.profile,
    profileVersion: status.profileVersion,
    promptConfig: status.promptConfig,
    evidenceProfile: status.evidenceProfile,
  };
}

export async function loadResearchLabRunStreamPayload(env: Env, runId: string): Promise<{
  status: ResearchLabRunStatusResponse;
  results: ResearchLabRunResultsResponse;
} | null> {
  const status = await loadResearchLabRunStatusPayload(env, runId);
  if (!status) return null;
  const [evidenceRows, outputRows] = await Promise.all([
    loadResearchLabEvidenceForRun(env, runId),
    loadResearchLabOutputsForRun(env, runId),
  ]);
  const evidenceByItem = new Map<string, typeof evidenceRows>();
  for (const row of evidenceRows) {
    const current = evidenceByItem.get(row.runItemId) ?? [];
    current.push(row);
    evidenceByItem.set(row.runItemId, current);
  }
  const outputByItem = new Map(outputRows.map((row) => [row.runItemId, row]));
  const results: ResearchLabRunResultsResponse = {
    run: status.run,
    items: status.items.map((item) => ({
      item,
      events: status.events.filter((event) => event.runItemId === item.id),
      evidence: evidenceByItem.get(item.id) ?? [],
      output: outputByItem.get(item.id) ?? null,
    })),
    profile: status.profile,
    profileVersion: status.profileVersion,
    promptConfig: status.promptConfig,
    evidenceProfile: status.evidenceProfile,
  };
  return { status, results };
}

export async function loadResearchLabTickerHistoryPayload(env: Env, ticker: string) {
  return loadResearchLabTickerHistory(env, ticker);
}
