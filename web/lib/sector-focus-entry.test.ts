import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFocusTickerOptions,
  parseFocusTickerInput,
  previewFocusName,
} from "./sector-focus-entry";

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
