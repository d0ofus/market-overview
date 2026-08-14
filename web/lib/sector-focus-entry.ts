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

export type FocusChartMode = "selected" | "narrative" | "peer";

export type FocusChartModeOption = {
  mode: FocusChartMode;
  categoryLabel: "Selection" | "Narrative" | "Peer group";
  buttonLabel: string;
  tickerCount: number | null;
  disabled: boolean;
};

export function getAdjacentFocusNarrativeIndex(input: {
  ids: string[];
  activeId: string;
  offset: -1 | 1;
}): number | null {
  if (input.ids.length === 0) return null;
  const currentIndex = input.ids.indexOf(input.activeId);
  if (currentIndex < 0) return null;
  return (currentIndex + input.offset + input.ids.length) % input.ids.length;
}

export function getFocusNarrativeKeyboardOffset(input: {
  key: string;
  focusNarrativeOpen: boolean;
  expandedChartOpen: boolean;
  saving: boolean;
  total: number;
  defaultPrevented: boolean;
  isComposing: boolean;
  editableTarget: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): -1 | 1 | null {
  if (
    !input.focusNarrativeOpen
    || input.expandedChartOpen
    || input.saving
    || input.total <= 1
    || input.defaultPrevented
    || input.isComposing
    || input.editableTarget
    || input.altKey
    || input.ctrlKey
    || input.metaKey
    || input.shiftKey
  ) return null;
  if (input.key === "ArrowLeft") return -1;
  if (input.key === "ArrowRight") return 1;
  return null;
}

export function buildFocusChartModeOptions(input: {
  selectedCount: number;
  narrativeName: string | null;
  narrativeCount: number;
  peerGroupName: string | null;
  peerGroupCount: number | null;
  peerGroupLoading: boolean;
  peerGroupError: boolean;
}): FocusChartModeOption[] {
  const options: FocusChartModeOption[] = [{
    mode: "selected",
    categoryLabel: "Selection",
    buttonLabel: `Selected (${input.selectedCount})`,
    tickerCount: input.selectedCount,
    disabled: false,
  }];
  const narrativeName = input.narrativeName?.trim();
  if (narrativeName) {
    options.push({
      mode: "narrative",
      categoryLabel: "Narrative",
      buttonLabel: `All ${narrativeName} (${input.narrativeCount})`,
      tickerCount: input.narrativeCount,
      disabled: false,
    });
  }
  const peerGroupName = input.peerGroupName?.trim();
  if (peerGroupName) {
    const unavailable = input.peerGroupError || input.peerGroupCount === null;
    options.push({
      mode: "peer",
      categoryLabel: "Peer group",
      buttonLabel: input.peerGroupLoading
        ? `All ${peerGroupName} (loading…)`
        : unavailable
          ? `All ${peerGroupName} (unavailable)`
          : `All ${peerGroupName} (${input.peerGroupCount})`,
      tickerCount: unavailable ? null : input.peerGroupCount,
      disabled: input.peerGroupLoading || unavailable,
    });
  }
  return options;
}

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
