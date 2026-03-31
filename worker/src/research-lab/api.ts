import type { Env } from "../types";
import { RESEARCH_LAB_RESULTS_EVENT_LIMIT } from "./constants";
import {
  loadResearchLabEvidenceForRunItem,
  loadResearchLabEvidenceProfile,
  loadResearchLabOutputForRunItem,
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
  const [items, events, promptConfig, evidenceProfile] = await Promise.all([
    loadResearchLabRunItems(env, runId),
    loadResearchLabRunEvents(env, runId, RESEARCH_LAB_RESULTS_EVENT_LIMIT),
    run.promptConfigId ? loadResearchLabPromptConfig(env, run.promptConfigId) : loadResearchLabPromptConfig(env, null),
    run.evidenceProfileId ? loadResearchLabEvidenceProfile(env, run.evidenceProfileId) : loadResearchLabEvidenceProfile(env, null),
  ]);
  return {
    run,
    items,
    events,
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
  const items = await Promise.all(status.items.map(async (item) => ({
    item,
    events: status.events.filter((event) => event.runItemId === item.id),
    evidence: await loadResearchLabEvidenceForRunItem(env, item.id),
    output: await loadResearchLabOutputForRunItem(env, item.id),
  })));
  return {
    run: status.run,
    items,
    promptConfig: status.promptConfig,
    evidenceProfile: status.evidenceProfile,
  };
}

export async function loadResearchLabRunStreamPayload(env: Env, runId: string): Promise<{
  status: ResearchLabRunStatusResponse;
  results: ResearchLabRunResultsResponse;
} | null> {
  const [status, results] = await Promise.all([
    loadResearchLabRunStatusPayload(env, runId),
    loadResearchLabRunResultsPayload(env, runId),
  ]);
  if (!status || !results) return null;
  return { status, results };
}

export async function loadResearchLabTickerHistoryPayload(env: Env, ticker: string) {
  return loadResearchLabTickerHistory(env, ticker);
}
