export type FocusTickerOption = {
  ticker: string;
  name: string | null;
  inNarrative: boolean;
  inPeerGroup: boolean;
  manual: boolean;
};

export type FocusNamePreview = {
  displayName: string;
  manualNameRequired: boolean;
  valid: boolean;
};

export const FOCUS_TICKER_PATTERN = /^[A-Z.\-^]{1,20}$/;

export function normalizeFocusTickers(values: string[]): string[] {
  return Array.from(new Set(
    values
      .map((value) => value.trim().toUpperCase())
      .filter((value) => FOCUS_TICKER_PATTERN.test(value)),
  ));
}

export function parseFocusTickerInput(value: string): string[] {
  return normalizeFocusTickers(value.split(/[\s,]+/));
}

export function buildFocusTickerOptions(input: {
  narrativeTickers: Array<{ ticker: string; name?: string | null }>;
  peerGroupTickers: Array<{ ticker: string; name?: string | null }>;
  manualTickers: string[];
}): FocusTickerOption[] {
  const narrativeMap = new Map(input.narrativeTickers.map((row) => [row.ticker.trim().toUpperCase(), row.name ?? null]));
  const peerMap = new Map(input.peerGroupTickers.map((row) => [row.ticker.trim().toUpperCase(), row.name ?? null]));
  const manual = new Set(normalizeFocusTickers(input.manualTickers));
  const tickers = normalizeFocusTickers([
    ...Array.from(narrativeMap.keys()),
    ...Array.from(peerMap.keys()),
    ...Array.from(manual),
  ]);
  return tickers.map((ticker) => ({
    ticker,
    name: narrativeMap.get(ticker) ?? peerMap.get(ticker) ?? null,
    inNarrative: narrativeMap.has(ticker),
    inPeerGroup: peerMap.has(ticker),
    manual: manual.has(ticker) && !narrativeMap.has(ticker) && !peerMap.has(ticker),
  }));
}

function subset(selected: string[], universe: string[]): boolean {
  if (selected.length === 0) return false;
  const available = new Set(normalizeFocusTickers(universe));
  return selected.every((ticker) => available.has(ticker));
}

export function previewFocusName(input: {
  sourceNarrativeName: string | null;
  narrativeTickers: string[];
  sourcePeerGroupName: string | null;
  peerGroupTickers: string[];
  selectedTickers: string[];
  manualName: string;
}): FocusNamePreview {
  const selected = normalizeFocusTickers(input.selectedTickers);
  if (selected.length === 0) return { displayName: "", manualNameRequired: false, valid: false };
  // Match the Worker rule: peer group wins overlap.
  if (input.sourcePeerGroupName && subset(selected, input.peerGroupTickers)) {
    return { displayName: input.sourcePeerGroupName, manualNameRequired: false, valid: true };
  }
  if (input.sourceNarrativeName && subset(selected, input.narrativeTickers)) {
    return { displayName: input.sourceNarrativeName, manualNameRequired: false, valid: true };
  }
  const manualName = input.manualName.trim();
  return { displayName: manualName, manualNameRequired: true, valid: Boolean(manualName) };
}
