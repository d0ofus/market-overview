export type OverviewGenerationDecision = {
  publish: boolean;
  bootstrap: boolean;
  reason: string | null;
};

export function evaluateOverviewGeneration(input: {
  hasReadyGeneration: boolean;
  criticalTickersPresent: boolean;
  currentCoveragePct: number;
  historyCoveragePct: number;
}): OverviewGenerationDecision {
  const fullReady = input.criticalTickersPresent
    && input.currentCoveragePct >= 95
    && input.historyCoveragePct >= 95;
  if (fullReady) return { publish: true, bootstrap: false, reason: null };
  const totalCoveragePct = Math.min(input.currentCoveragePct, input.historyCoveragePct);
  const bootstrap = !input.hasReadyGeneration
    && input.criticalTickersPresent
    && totalCoveragePct >= 80;
  if (bootstrap) {
    return {
      publish: true,
      bootstrap: true,
      reason: `First-generation bootstrap published at ${totalCoveragePct.toFixed(2)}% coverage.`,
    };
  }
  const reasons = [];
  if (!input.criticalTickersPresent) reasons.push("one or more critical tickers are missing");
  if (input.currentCoveragePct < 95) reasons.push(`current coverage is ${input.currentCoveragePct.toFixed(2)}%`);
  if (input.historyCoveragePct < 95) reasons.push(`history coverage is ${input.historyCoveragePct.toFixed(2)}%`);
  return {
    publish: false,
    bootstrap: false,
    reason: `${reasons.join("; ")}; last-ready generation retained.`,
  };
}
