import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFocusChartModeOptions,
  buildFocusTickerOptions,
  parseFocusTickerInput,
  previewFocusName,
} from "./sector-focus-entry";

test("chart source options distinguish same-name sources and show all counts", () => {
  assert.deepEqual(buildFocusChartModeOptions({
    selectedCount: 6,
    narrativeName: "Tobacco",
    narrativeCount: 9,
    peerGroupName: "Tobacco",
    peerGroupCount: 9,
    peerGroupLoading: false,
    peerGroupError: false,
  }), [
    { mode: "selected", categoryLabel: "Selection", buttonLabel: "Selected (6)", tickerCount: 6, disabled: false },
    { mode: "narrative", categoryLabel: "Narrative", buttonLabel: "All Tobacco (9)", tickerCount: 9, disabled: false },
    { mode: "peer", categoryLabel: "Peer group", buttonLabel: "All Tobacco (9)", tickerCount: 9, disabled: false },
  ]);
});

test("chart source options omit unavailable sources", () => {
  assert.deepEqual(buildFocusChartModeOptions({
    selectedCount: 2,
    narrativeName: null,
    narrativeCount: 0,
    peerGroupName: null,
    peerGroupCount: null,
    peerGroupLoading: false,
    peerGroupError: false,
  }), [
    { mode: "selected", categoryLabel: "Selection", buttonLabel: "Selected (2)", tickerCount: 2, disabled: false },
  ]);
});

test("chart source options show peer loading and failure without false counts", () => {
  const base = {
    selectedCount: 3,
    narrativeName: null,
    narrativeCount: 0,
    peerGroupName: "Tobacco",
    peerGroupCount: null,
  };
  assert.equal(buildFocusChartModeOptions({
    ...base,
    peerGroupLoading: true,
    peerGroupError: false,
  })[1]?.buttonLabel, "All Tobacco (loading…)");
  assert.equal(buildFocusChartModeOptions({
    ...base,
    peerGroupLoading: false,
    peerGroupError: true,
  })[1]?.buttonLabel, "All Tobacco (unavailable)");
  assert.equal(buildFocusChartModeOptions({
    ...base,
    peerGroupLoading: false,
    peerGroupError: true,
  })[1]?.disabled, true);
});

test("chart source options retain a zero narrative count", () => {
  assert.equal(buildFocusChartModeOptions({
    selectedCount: 1,
    narrativeName: "Empty narrative",
    narrativeCount: 0,
    peerGroupName: null,
    peerGroupCount: null,
    peerGroupLoading: false,
    peerGroupError: false,
  })[1]?.buttonLabel, "All Empty narrative (0)");
});

test("manual ticker input normalizes and rejects malformed tokens", () => {
  assert.deepEqual(parseFocusTickerInput(" nvda, brk.b  VRT bad/ticker NVDA "), ["NVDA", "BRK.B", "VRT"]);
});

test("source suggestions merge without selecting or duplicating tickers", () => {
  assert.deepEqual(buildFocusTickerOptions({
    narrativeTickers: [{ ticker: "NVDA", name: "NVIDIA" }, { ticker: "VRT", name: "Vertiv" }],
    peerGroupTickers: [{ ticker: "NVDA", name: "NVIDIA" }, { ticker: "AMD", name: "AMD" }],
    manualTickers: ["TSLA"],
  }), [
    { ticker: "NVDA", name: "NVIDIA", inNarrative: true, inPeerGroup: true, manual: false },
    { ticker: "VRT", name: "Vertiv", inNarrative: true, inPeerGroup: false, manual: false },
    { ticker: "AMD", name: "AMD", inNarrative: false, inPeerGroup: true, manual: false },
    { ticker: "TSLA", name: null, inNarrative: false, inPeerGroup: false, manual: true },
  ]);
});

test("name preview gives peer group precedence for overlap", () => {
  assert.deepEqual(previewFocusName({
    sourceNarrativeName: "AI Infrastructure",
    narrativeTickers: ["NVDA", "AVGO", "VRT"],
    sourcePeerGroupName: "Semiconductors",
    peerGroupTickers: ["NVDA", "AVGO", "AMD"],
    selectedTickers: ["NVDA", "AVGO"],
    manualName: "Ignored",
  }), { displayName: "Semiconductors", manualNameRequired: false, valid: true });
});

test("name preview requires a manual name for mixed selections", () => {
  assert.deepEqual(previewFocusName({
    sourceNarrativeName: "AI Infrastructure",
    narrativeTickers: ["NVDA", "VRT"],
    sourcePeerGroupName: "Semiconductors",
    peerGroupTickers: ["NVDA", "AMD"],
    selectedTickers: ["VRT", "AMD"],
    manualName: "",
  }), { displayName: "", manualNameRequired: true, valid: false });
  assert.deepEqual(previewFocusName({
    sourceNarrativeName: "AI Infrastructure",
    narrativeTickers: ["NVDA", "VRT"],
    sourcePeerGroupName: "Semiconductors",
    peerGroupTickers: ["NVDA", "AMD"],
    selectedTickers: ["VRT", "AMD"],
    manualName: "AI power mix",
  }), { displayName: "AI power mix", manualNameRequired: true, valid: true });
});
