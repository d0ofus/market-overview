import { describe, expect, it } from "vitest";
import {
  deriveFocusNarrativeName,
  FocusNarrativeValidationError,
  normalizeFocusTickers,
} from "../src/sector-focus-narratives-service";

const base = {
  narrativeName: "AI Infrastructure",
  narrativeTickers: ["NVDA", "AVGO", "VRT"],
  peerGroupId: "pg-semis",
  peerGroupName: "Semiconductors",
  peerGroupTickers: ["NVDA", "AVGO", "AMD"],
};

describe("sector focus narrative naming", () => {
  it("normalizes and deduplicates valid tickers", () => {
    expect(normalizeFocusTickers([" nvda ", "NVDA", "brk.b", "bad ticker", 42])).toEqual(["NVDA", "BRK.B"]);
  });

  it("uses the narrative name for a narrative-only subset", () => {
    expect(deriveFocusNarrativeName({ ...base, peerGroupId: null, peerGroupName: null, peerGroupTickers: [], manualName: null, selectedTickers: ["NVDA", "VRT"] }).sectorName)
      .toBe("AI Infrastructure");
  });

  it("uses the peer-group name for a peer-only subset", () => {
    expect(deriveFocusNarrativeName({ ...base, narrativeName: null, narrativeTickers: [], manualName: null, selectedTickers: ["NVDA", "AMD"] }).sectorName)
      .toBe("Semiconductors");
  });

  it("gives the peer group precedence when both sources contain all selections", () => {
    expect(deriveFocusNarrativeName({ ...base, manualName: "Ignored", selectedTickers: ["NVDA", "AVGO"] }).sectorName)
      .toBe("Semiconductors");
  });

  it("uses the narrative when both are selected but only the narrative contains the full selection", () => {
    expect(deriveFocusNarrativeName({ ...base, manualName: null, selectedTickers: ["NVDA", "VRT"] }).sectorName)
      .toBe("AI Infrastructure");
  });

  it("uses the peer group when both are selected but only the peer group contains the full selection", () => {
    expect(deriveFocusNarrativeName({ ...base, manualName: null, selectedTickers: ["NVDA", "AMD"] }).sectorName)
      .toBe("Semiconductors");
  });

  it("requires a manual name for a mixed source selection", () => {
    expect(() => deriveFocusNarrativeName({ ...base, manualName: null, selectedTickers: ["VRT", "AMD"] }))
      .toThrowError(FocusNarrativeValidationError);
    expect(deriveFocusNarrativeName({ ...base, manualName: "AI Power Mix", selectedTickers: ["VRT", "AMD"] }).sectorName)
      .toBe("AI Power Mix");
  });

  it("requires a manual name for outside and manual-only selections", () => {
    expect(() => deriveFocusNarrativeName({ ...base, manualName: null, selectedTickers: ["TSLA"] })).toThrow(/Entry name is required/);
    expect(deriveFocusNarrativeName({ narrativeName: null, narrativeTickers: [], peerGroupId: null, peerGroupName: null, peerGroupTickers: [], manualName: "Custom", selectedTickers: ["TSLA"] }).sectorName)
      .toBe("Custom");
  });

  it("rejects an empty selection", () => {
    expect(() => deriveFocusNarrativeName({ ...base, manualName: "Empty", selectedTickers: [] })).toThrow(/At least one ticker/);
  });
});
