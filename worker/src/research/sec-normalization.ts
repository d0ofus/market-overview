import type { Env } from "../types";
import { resolveTickerMeta } from "../symbol-resolver";
import { getSecResearchProvider } from "./providers";

function guessIrDomain(companyName: string | null, ticker: string): string | null {
  const base = (companyName ?? ticker)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join("");
  return base ? `${base}.com` : null;
}

export async function normalizeResearchTicker(env: Env, ticker: string): Promise<{
  ticker: string;
  companyName: string | null;
  exchange: string | null;
  secCik: string | null;
  irDomain: string | null;
}> {
  const resolved = await resolveTickerMeta(ticker, env).catch(() => null);
  const secProvider = getSecResearchProvider(env);
  const issuer = await secProvider.resolveIssuer(ticker, env).catch(() => null);
  const companyName = resolved?.name ?? issuer?.companyName ?? null;
  return {
    ticker,
    companyName,
    exchange: resolved?.exchange ?? null,
    secCik: issuer?.cik ?? null,
    irDomain: guessIrDomain(companyName, ticker),
  };
}
