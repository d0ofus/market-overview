export type OverviewGenerationDecision = {
  publish: boolean;
  bootstrap: boolean;
  degraded: boolean;
  reason: string | null;
};

export function evaluateOverviewGeneration(input: {
  hasReadyGeneration: boolean;
  criticalTickersPresent: boolean;
  currentCoveragePct: number;
  historyCoveragePct: number;
}): OverviewGenerationDecision {
  const fullReady = input.criticalTickersPresent
    && input.currentCoveragePct >= 95;
  if (fullReady) {
    return {
      publish: true,
      bootstrap: !input.hasReadyGeneration,
      degraded: false,
      reason: null,
    };
  }
  const degraded = input.criticalTickersPresent
    && input.currentCoveragePct >= 90;
  if (degraded) {
    return {
      publish: true,
      bootstrap: !input.hasReadyGeneration,
      degraded: true,
      reason: `Degraded generation published at ${input.currentCoveragePct.toFixed(2)}% essential current-field coverage; latest valid history remains available (${input.historyCoveragePct.toFixed(2)}% exact-session).`,
    };
  }
  const reasons = [];
  if (!input.criticalTickersPresent) reasons.push("one or more critical tickers are missing");
  if (input.currentCoveragePct < 90) reasons.push(`essential current-field coverage is ${input.currentCoveragePct.toFixed(2)}%`);
  return {
    publish: false,
    bootstrap: false,
    degraded: false,
    reason: `${reasons.join("; ")}; last-ready generation retained.`,
  };
}
