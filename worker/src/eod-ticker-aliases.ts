export type ReviewedEodTickerAlias = Readonly<{
  currentSymbol: string;
  effectiveDate: string;
  asofDate: string;
  sourceUrl: string;
  name: string;
}>;

// Issuer notice: the fund name changed June 1; the ticker changed June 22.
// Alpaca's documented asof mapping identifies the same fund using its last
// pre-rename trading symbol, retaining the frozen RSHO logical/storage key.
// https://docs.alpaca.markets/us/reference/stockbars (asof)
const RSHO_ALIAS: ReviewedEodTickerAlias = Object.freeze({
  currentSymbol: "WELD",
  effectiveDate: "2026-06-22",
  asofDate: "2026-06-18",
  sourceUrl: "https://temaetfs.com/rsho-landing-page",
  name: "Tema U.S. Manufacturing & Reshoring ETF",
});

export function reviewedEodTickerAlias(ticker: string, targetSession: string): ReviewedEodTickerAlias | null {
  return ticker.trim().toUpperCase() === "RSHO" && /^\d{4}-\d{2}-\d{2}$/.test(targetSession)
    && targetSession >= RSHO_ALIAS.effectiveDate ? RSHO_ALIAS : null;
}
