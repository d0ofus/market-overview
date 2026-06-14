import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzePerplexityBodyText,
  mergeCompany,
  parseCompanyFromText,
  parseNotablePriceMovementFromText,
  parsePeersFromText,
  parsePeersPresetPayload,
  parseProfileDescriptionPayload,
  parseProfilePayload,
} from "./perplexity-finance-parser";

test("parses peers from Perplexity list preset JSON", () => {
  const rows = parsePeersPresetPayload([
    {
      symbol: "CSTM",
      name: "Constellium SE",
      price: 35.28,
      changesPercentage: 6.14,
      exchange: null,
    },
    {
      symbol: "AA",
      name: "Alcoa Corporation",
      price: 72.17,
    },
    {
      symbol: "KALU",
      name: "Kaiser Aluminum Corporation",
      price: 186,
      changesPercentage: 5.74,
    },
  ], "AA");

  assert.deepEqual(rows.map((row) => row.ticker), ["CSTM", "KALU"]);
  assert.equal(rows[0]?.name, "Constellium SE");
  assert.match(rows[0]?.rawText ?? "", /Constellium SE CSTM/);
});

test("parses profile description JSON and profile metadata JSON", () => {
  const generatedDescription = parseProfileDescriptionPayload(
    "Guardant Health, Inc. (NASDAQ: GH) is a precision oncology company.",
  );
  const profile = parseProfilePayload({
    companyName: "Guardant Health, Inc.",
    exchange: "NASDAQ Global Select",
    sector: "Healthcare",
    industry: "Medical - Diagnostics & Research",
    description: "Guardant Health, Inc., a precision oncology company, provides blood tests.",
  });

  const company = mergeCompany({ description: generatedDescription }, profile);
  assert.equal(company.name, "Guardant Health, Inc.");
  assert.equal(company.exchange, "NASDAQ Global Select");
  assert.equal(company.description, "Guardant Health, Inc. (NASDAQ: GH) is a precision oncology company.");
});

test("detects Cloudflare security and pending list shells", () => {
  assert.equal(
    analyzePerplexityBodyText("www.perplexity.ai\nPerforming security verification\nEnable JavaScript and cookies to continue"),
    "blocked",
  );
  assert.equal(
    analyzePerplexityBodyText("AA Peers\nAnalyzing list...\nPrice\t1D\t5D\t1M\t6M"),
    "pending",
  );
  assert.equal(analyzePerplexityBodyText("404 Page Not Found\nReturn home"), "not_found");
});

test("falls back to rendered table text without avatar prefixes in names", () => {
  const rows = parsePeersFromText(`
    GH Peers
    Price 1D 5D 1M 6M
    B bioAffinity Technologies, Inc. BIAF $1.65 5.77% 2.48% -26.01% 13.79%
    S SOPHiA GENETICS S.A. SOPH $5.01 2.66% 2.66% 3.30% 1.62%
  `, "GH");

  assert.deepEqual(rows.map((row) => row.ticker), ["BIAF", "SOPH"]);
  assert.equal(rows[0]?.name, "bioAffinity Technologies, Inc.");
  assert.equal(rows[1]?.name, "SOPHiA GENETICS S.A.");
});

test("DOM profile fallback prefers company description over price movement commentary", () => {
  const company = parseCompanyFromText(`
    Guardant Health, Inc.
    GH
    Exchange
    NASDAQ Global Select
    Sector
    Healthcare
    Industry
    Medical - Diagnostics & Research
    May 26 $119.85 0.76% Guardant Health edged higher, closing near its 52-week high, as investors digested FDA approval and analyst price target changes.
    Guardant Health, Inc. (NASDAQ: GH) is a Redwood City, California-based precision oncology company that provides blood tests, tissue tests, data sets, and analytics to detect, monitor, and guide treatment for cancer across stages of care.
  `, "GH");

  assert.equal(company.name, "Guardant Health, Inc.");
  assert.equal(company.exchange, "NASDAQ Global Select");
  assert.equal(company.description?.startsWith("Guardant Health, Inc. (NASDAQ: GH) is"), true);
});

test("extracts the visible Notable Price Movement paragraph from rendered finance text", () => {
  const expected = "Murphy USA surged roughly 10%, closing near its 52-week high after stronger-than-expected quarterly results and upbeat commentary lifted investor confidence in the fuel retailer's margins and merchandise sales.";
  const result = parseNotablePriceMovementFromText(`
    Murphy USA Inc.
    MUSA
    Key Stats
    Notable Price Movement
    ${expected}
    Sources
    3 sources
    Company Profile
    Murphy USA operates retail fuel stores.
  `);

  assert.equal(result.notablePriceMovement, expected);
  assert.equal(result.matchedSelector, "text:Notable Price Movement");
  assert.ok(result.observedHeadings.includes("Notable Price Movement"));
});

test("stops notable price movement extraction before the next section heading", () => {
  const result = parseNotablePriceMovementFromText(`
    Notable Price Movement
    Murphy USA surged roughly 10%, closing near its 52-week high.
    Company Profile
    Murphy USA Inc. operates convenience stores and fuel stations.
  `);

  assert.equal(result.notablePriceMovement, "Murphy USA surged roughly 10%, closing near its 52-week high.");
});

test("supports close notable movement heading variants and inline text", () => {
  const result = parseNotablePriceMovementFromText(`
    Price Movement: Shares rose 6.2% after analysts raised price targets following earnings.
    Financials
    Revenue
  `);

  assert.equal(result.notablePriceMovement, "Shares rose 6.2% after analysts raised price targets following earnings.");
  assert.equal(result.matchedSelector, "text:inline-notable-price-movement");
});

test("returns no notable price movement when the rendered section is absent", () => {
  const result = parseNotablePriceMovementFromText(`
    Murphy USA Inc.
    Key Stats
    Company Profile
    Murphy USA operates retail fuel stores.
  `);

  assert.equal(result.notablePriceMovement, null);
  assert.equal(result.matchedSelector, null);
});
