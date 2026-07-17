export const FOCUS_TICKER_PATTERN = /^[A-Z.\-^]{1,20}$/;

export type FocusSourceUniverse = {
  narrativeName: string | null;
  narrativeTickers: string[];
  peerGroupId: string | null;
  peerGroupName: string | null;
  peerGroupTickers: string[];
};

export type FocusNameInput = FocusSourceUniverse & {
  manualName: string | null;
  selectedTickers: string[];
};

export type FocusNameResult = {
  sectorName: string;
  manualName: string | null;
  selectedTickers: string[];
  requiresManualName: boolean;
};

export class FocusNarrativeValidationError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "FocusNarrativeValidationError";
  }
}

export function normalizeFocusTickers(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(
    values
      .map((value) => (typeof value === "string" ? value.trim().toUpperCase() : ""))
      .filter((value) => FOCUS_TICKER_PATTERN.test(value)),
  ));
}

function isSubset(values: string[], universe: string[]): boolean {
  if (values.length === 0) return false;
  const universeSet = new Set(normalizeFocusTickers(universe));
  return values.every((ticker) => universeSet.has(ticker));
}

export function deriveFocusNarrativeName(input: FocusNameInput): FocusNameResult {
  const selectedTickers = normalizeFocusTickers(input.selectedTickers);
  if (selectedTickers.length === 0) {
    throw new FocusNarrativeValidationError("At least one ticker must be selected.");
  }

  const narrativeName = input.narrativeName?.trim() || null;
  const peerGroupName = input.peerGroupName?.trim() || null;
  const manualName = input.manualName?.trim() || null;
  const inNarrative = Boolean(narrativeName) && isSubset(selectedTickers, input.narrativeTickers);
  const inPeerGroup = Boolean(input.peerGroupId && peerGroupName) && isSubset(selectedTickers, input.peerGroupTickers);

  // Peer group wins the deliberate overlap case.
  if (inPeerGroup) {
    return { sectorName: peerGroupName!, manualName, selectedTickers, requiresManualName: false };
  }
  if (inNarrative) {
    return { sectorName: narrativeName!, manualName, selectedTickers, requiresManualName: false };
  }
  if (!manualName) {
    throw new FocusNarrativeValidationError(
      "Entry name is required when selected tickers mix sources or fall outside the selected narrative or peer group.",
    );
  }
  return { sectorName: manualName, manualName, selectedTickers, requiresManualName: true };
}
