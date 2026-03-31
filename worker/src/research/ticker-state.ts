export function resetResearchTickerTransientState() {
  return {
    snapshotId: null,
    rankingRowId: null,
    workingJson: {} as Record<string, unknown>,
  };
}
