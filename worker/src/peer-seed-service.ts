import { resolveTickerMeta } from "./symbol-resolver";
import {
  createPeerGroup,
  loadPeerTickerDetail,
  mergeMembershipSource,
  slugifyPeerGroupName,
  upsertTickerPeerMembership,
  type PeerMembershipSource,
} from "./peer-groups-service";
import type { Env } from "./types";

type SeedProfile = {
  ticker: string;
  name: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  sharesOutstanding: number | null;
};

type SeedCandidate = {
  ticker: string;
  confidence: number | null;
  sources: Set<PeerMembershipSource>;
};

function normalizeTicker(value: string): string {
  return String(value ?? "").trim().toUpperCase();
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function fetchFinnhubPeers(ticker: string, token: string): Promise<string[]> {
  const res = await fetch(`https://finnhub.io/api/v1/stock/peers?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(token)}`, {
    headers: { "User-Agent": "market-command-centre/1.0" },
  });
  if (!res.ok) throw new Error(`Finnhub peers request failed (${res.status})`);
  const json = await res.json() as unknown;
  return Array.isArray(json) ? json.map((value) => normalizeTicker(value)).filter(Boolean) : [];
}

async function fetchFmpPeers(ticker: string, apiKey: string): Promise<string[]> {
  const urls = [
    `https://financialmodelingprep.com/stable/stock-peers?symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(apiKey)}`,
    `https://financialmodelingprep.com/api/v4/stock_peers?symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(apiKey)}`,
  ];
  for (const url of urls) {
    const res = await fetch(url, { headers: { "User-Agent": "market-command-centre/1.0" } });
    if (!res.ok) continue;
    const json = await res.json() as unknown;
    if (Array.isArray(json)) {
      const first = json[0] as any;
      if (typeof first === "string") return json.map((value) => normalizeTicker(value)).filter(Boolean);
      if (first && typeof first === "object" && Array.isArray(first.peersList)) {
        return first.peersList.map((value: unknown) => normalizeTicker(value)).filter(Boolean);
      }
    }
    if (json && typeof json === "object" && Array.isArray((json as any).peersList)) {
      return (json as any).peersList.map((value: unknown) => normalizeTicker(value)).filter(Boolean);
    }
  }
  return [];
}

async function fetchFinnhubProfile(ticker: string, token: string): Promise<SeedProfile | null> {
  const res = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(token)}`, {
    headers: { "User-Agent": "market-command-centre/1.0" },
  });
  if (!res.ok) return null;
  const json = await res.json() as any;
  if (!json || typeof json !== "object") return null;
  return {
    ticker,
    name: typeof json.name === "string" ? json.name : null,
    exchange: typeof json.exchange === "string" ? json.exchange : null,
    sector: typeof json.finnhubIndustry === "string" ? json.finnhubIndustry : null,
    industry: typeof json.finnhubIndustry === "string" ? json.finnhubIndustry : null,
    sharesOutstanding: parseNumber(json.shareOutstanding ?? json.shareOutstandingFloat),
  };
}

async function fetchFmpProfile(ticker: string, apiKey: string): Promise<SeedProfile | null> {
  const urls = [
    `https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(apiKey)}`,
    `https://financialmodelingprep.com/api/v3/profile/${encodeURIComponent(ticker)}?apikey=${encodeURIComponent(apiKey)}`,
  ];
  for (const url of urls) {
    const res = await fetch(url, { headers: { "User-Agent": "market-command-centre/1.0" } });
    if (!res.ok) continue;
    const json = await res.json() as any;
    const row = Array.isArray(json) ? json[0] : json;
    if (!row || typeof row !== "object") continue;
    return {
      ticker,
      name: typeof row.companyName === "string" ? row.companyName : typeof row.name === "string" ? row.name : null,
      exchange: typeof row.exchangeShortName === "string" ? row.exchangeShortName : typeof row.exchange === "string" ? row.exchange : null,
      sector: typeof row.sector === "string" ? row.sector : null,
      industry: typeof row.industry === "string" ? row.industry : null,
      sharesOutstanding: parseNumber(row.sharesOutstanding),
    };
  }
  return null;
}

async function loadSeedProfile(ticker: string, env: Env): Promise<SeedProfile | null> {
  const [finnhubProfile, fmpProfile, resolvedMeta] = await Promise.all([
    env.FINNHUB_API_KEY ? fetchFinnhubProfile(ticker, env.FINNHUB_API_KEY).catch(() => null) : Promise.resolve(null),
    env.FMP_API_KEY ? fetchFmpProfile(ticker, env.FMP_API_KEY).catch(() => null) : Promise.resolve(null),
    resolveTickerMeta(ticker, env).catch(() => null),
  ]);
  return {
    ticker,
    name: fmpProfile?.name ?? finnhubProfile?.name ?? resolvedMeta?.name ?? ticker,
    exchange: fmpProfile?.exchange ?? finnhubProfile?.exchange ?? resolvedMeta?.exchange ?? null,
    sector: fmpProfile?.sector ?? finnhubProfile?.sector ?? null,
    industry: fmpProfile?.industry ?? finnhubProfile?.industry ?? null,
    sharesOutstanding: fmpProfile?.sharesOutstanding ?? finnhubProfile?.sharesOutstanding ?? null,
  };
}

async function upsertSeedSymbol(env: Env, profile: SeedProfile): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO symbols (ticker, name, exchange, asset_class, sector, industry, shares_outstanding, updated_at)
     VALUES (?, ?, ?, 'equity', ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(ticker) DO UPDATE SET
       name = COALESCE(excluded.name, symbols.name),
       exchange = COALESCE(excluded.exchange, symbols.exchange),
       sector = COALESCE(excluded.sector, symbols.sector),
       industry = COALESCE(excluded.industry, symbols.industry),
       shares_outstanding = COALESCE(excluded.shares_outstanding, symbols.shares_outstanding),
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      profile.ticker,
      profile.name ?? profile.ticker,
      profile.exchange ?? null,
      profile.sector ?? null,
      profile.industry ?? null,
      profile.sharesOutstanding,
    )
    .run();
}

export async function seedPeerGroupForTicker(env: Env, tickerInput: string): Promise<{
  groupId: string;
  ticker: string;
  insertedTickers: string[];
  sourceBreakdown: Record<string, number>;
}> {
  const ticker = normalizeTicker(tickerInput);
  if (!/^[A-Z.\-^]{1,20}$/.test(ticker)) throw new Error("Valid ticker is required.");
  if (!env.FINNHUB_API_KEY && !env.FMP_API_KEY) {
    throw new Error("FINNHUB_API_KEY or FMP_API_KEY is required for peer seeding.");
  }

  const [finnhubPeers, fmpPeers, rootProfile] = await Promise.all([
    env.FINNHUB_API_KEY ? fetchFinnhubPeers(ticker, env.FINNHUB_API_KEY).catch(() => []) : Promise.resolve([]),
    env.FMP_API_KEY ? fetchFmpPeers(ticker, env.FMP_API_KEY).catch(() => []) : Promise.resolve([]),
    loadSeedProfile(ticker, env),
  ]);
  if (!rootProfile) throw new Error(`Unable to resolve metadata for ${ticker}.`);

  const candidates = new Map<string, SeedCandidate>();
  const register = (symbols: string[], source: PeerMembershipSource) => {
    for (const symbol of symbols) {
      const nextTicker = normalizeTicker(symbol);
      if (!/^[A-Z.\-^]{1,20}$/.test(nextTicker) || nextTicker === ticker) continue;
      const current = candidates.get(nextTicker) ?? { ticker: nextTicker, confidence: null, sources: new Set<PeerMembershipSource>() };
      current.sources.add(source);
      current.confidence = current.sources.size > 1 ? 1 : 0.6;
      candidates.set(nextTicker, current);
    }
  };
  register(finnhubPeers, "finnhub_seed");
  register(fmpPeers, "fmp_seed");
  if (candidates.size === 0) throw new Error(`No seed peers were returned for ${ticker}.`);

  await upsertSeedSymbol(env, rootProfile);

  const detail = await loadPeerTickerDetail(env, ticker);
  const slug = slugifyPeerGroupName(`${ticker}-fundamental-peers`);
  let groupId = detail?.groups.find((group) => group.slug === slug)?.id ?? null;
  if (!groupId) {
    const existing = await env.DB.prepare("SELECT id FROM peer_groups WHERE slug = ? LIMIT 1").bind(slug).first<{ id: string }>();
    groupId = existing?.id ?? (await createPeerGroup(env, {
      name: `${ticker} Fundamental Peers`,
      slug,
      groupType: "fundamental",
      description: `Seeded peer group for ${ticker}.`,
      priority: 100,
      isActive: true,
    })).id;
  }

  await upsertTickerPeerMembership(env, {
    ticker,
    peerGroupId: groupId,
    source: "system",
    confidence: 1,
  });

  const insertedTickers: string[] = [];
  const sourceBreakdown: Record<string, number> = {};
  for (const candidate of candidates.values()) {
    const profile = await loadSeedProfile(candidate.ticker, env);
    if (!profile) continue;
    await upsertSeedSymbol(env, profile);
    const source = Array.from(candidate.sources).reduce<PeerMembershipSource | null>((current, next) => mergeMembershipSource(current, next), null) ?? "system";
    await upsertTickerPeerMembership(env, {
      ticker: candidate.ticker,
      peerGroupId: groupId,
      source,
      confidence: candidate.confidence,
    });
    insertedTickers.push(candidate.ticker);
    sourceBreakdown[source] = (sourceBreakdown[source] ?? 0) + 1;
  }

  return {
    groupId,
    ticker,
    insertedTickers,
    sourceBreakdown,
  };
}

