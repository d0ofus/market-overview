import { resolveTickerMeta } from "./symbol-resolver";
import {
  createPeerGroup,
  isUsEquityExchange,
  isValidBootstrapRootTicker,
  loadPeerTickerDetail,
  mergeMembershipSource,
  removeTickerPeerMembership,
  slugifyPeerGroupName,
  updatePeerGroup,
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
  exchange: string | null;
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

function isUsPeerTicker(value: string): boolean {
  return isValidBootstrapRootTicker(value);
}

function cleanGroupLabel(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/fundamental peers$/i.test(text)) return null;
  return text;
}

export function deriveSeedGroupTitle(profile: SeedProfile, fallbackTicker: string): string {
  return cleanGroupLabel(profile.industry)
    ?? cleanGroupLabel(profile.sector)
    ?? `${fallbackTicker} Fundamental Peers`;
}

export function deriveSeedGroupSlug(title: string, groupType: "fundamental" | "technical" | "custom" = "fundamental"): string {
  return slugifyPeerGroupName(`${groupType}-${title}`);
}

async function loadExistingSymbolProfile(env: Env, ticker: string): Promise<SeedProfile | null> {
  const row = await env.DB.prepare(
    `SELECT
      ticker,
      name,
      exchange,
      sector,
      industry,
      shares_outstanding as sharesOutstanding
     FROM symbols
     WHERE ticker = ?
     LIMIT 1`,
  )
    .bind(ticker)
    .first<SeedProfile>();
  return row
    ? {
        ticker: row.ticker.toUpperCase(),
        name: row.name ?? null,
        exchange: row.exchange ?? null,
        sector: row.sector ?? null,
        industry: row.industry ?? null,
        sharesOutstanding: typeof row.sharesOutstanding === "number" ? row.sharesOutstanding : null,
      }
    : null;
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

async function loadSeedProfile(
  ticker: string,
  env: Env,
  options?: {
    allowExternalLookup?: boolean;
    providers?: Array<"finnhub" | "fmp">;
  },
): Promise<SeedProfile | null> {
  const existing = await loadExistingSymbolProfile(env, ticker);
  const allowExternalLookup = options?.allowExternalLookup !== false;
  const providers = options?.providers ?? ["finnhub", "fmp"];
  const shouldFetchFinnhub = allowExternalLookup && providers.includes("finnhub") && Boolean(env.FINNHUB_API_KEY);
  const shouldFetchFmp = allowExternalLookup && providers.includes("fmp") && Boolean(env.FMP_API_KEY);

  const [finnhubProfile, fmpProfile, resolvedMeta] = await Promise.all([
    shouldFetchFinnhub ? fetchFinnhubProfile(ticker, env.FINNHUB_API_KEY!).catch(() => null) : Promise.resolve(null),
    shouldFetchFmp ? fetchFmpProfile(ticker, env.FMP_API_KEY!).catch(() => null) : Promise.resolve(null),
    resolveTickerMeta(ticker, env).catch(() => null),
  ]);
  return {
    ticker,
    name: existing?.name ?? fmpProfile?.name ?? finnhubProfile?.name ?? resolvedMeta?.name ?? ticker,
    exchange: existing?.exchange ?? fmpProfile?.exchange ?? finnhubProfile?.exchange ?? resolvedMeta?.exchange ?? null,
    sector: existing?.sector ?? fmpProfile?.sector ?? finnhubProfile?.sector ?? null,
    industry: existing?.industry ?? fmpProfile?.industry ?? finnhubProfile?.industry ?? null,
    sharesOutstanding: existing?.sharesOutstanding ?? fmpProfile?.sharesOutstanding ?? finnhubProfile?.sharesOutstanding ?? null,
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

async function ensureSeedGroup(
  env: Env,
  ticker: string,
  profile: SeedProfile,
  existingDetailGroups: Array<{ id: string; slug: string }> | undefined,
): Promise<string> {
  const title = deriveSeedGroupTitle(profile, ticker);
  const slug = deriveSeedGroupSlug(title, "fundamental");
  const fromDetail = existingDetailGroups?.find((group) => group.slug === slug)?.id ?? null;
  if (fromDetail) return fromDetail;

  const existing = await env.DB.prepare("SELECT id FROM peer_groups WHERE slug = ? LIMIT 1").bind(slug).first<{ id: string }>();
  if (existing?.id) return existing.id;

  try {
    return (await createPeerGroup(env, {
      name: title,
      slug,
      groupType: "fundamental",
      description: `Seeded fundamental peer group for ${title}.`,
      priority: 100,
      isActive: true,
    })).id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (!message.includes("UNIQUE constraint failed: peer_groups.slug")) throw error;
    const retry = await env.DB.prepare("SELECT id FROM peer_groups WHERE slug = ? LIMIT 1").bind(slug).first<{ id: string }>();
    if (!retry?.id) throw error;
    return retry.id;
  }
}

export async function seedPeerGroupForTicker(
  env: Env,
  tickerInput: string,
  options?: {
    providerMode?: "both" | "finnhub" | "fmp";
    enrichPeers?: boolean;
    fallbackOnEmpty?: boolean;
  },
): Promise<{
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
  const providerMode = options?.providerMode ?? "both";
  const providers = providerMode === "both"
    ? (["finnhub", "fmp"] as Array<"finnhub" | "fmp">)
    : ([providerMode] as Array<"finnhub" | "fmp">);
  const enrichPeers = options?.enrichPeers === true;
  const fallbackOnEmpty = options?.fallbackOnEmpty !== false;
  if (providers.includes("finnhub") && !env.FINNHUB_API_KEY && providerMode !== "fmp") {
    throw new Error("FINNHUB_API_KEY is required for Finnhub peer seeding.");
  }
  if (providers.includes("fmp") && !env.FMP_API_KEY && providerMode !== "finnhub") {
    throw new Error("FMP_API_KEY is required for FMP peer seeding.");
  }

  const [finnhubPeers, fmpPeers, rootProfile] = await Promise.all([
    providers.includes("finnhub") && env.FINNHUB_API_KEY ? fetchFinnhubPeers(ticker, env.FINNHUB_API_KEY).catch(() => []) : Promise.resolve([]),
    providers.includes("fmp") && env.FMP_API_KEY ? fetchFmpPeers(ticker, env.FMP_API_KEY).catch(() => []) : Promise.resolve([]),
    loadSeedProfile(ticker, env, { allowExternalLookup: enrichPeers, providers }),
  ]);
  if (!rootProfile) throw new Error(`Unable to resolve metadata for ${ticker}.`);

  const candidates = new Map<string, SeedCandidate>();
  const register = (symbols: string[], source: PeerMembershipSource) => {
    for (const symbol of symbols) {
      const nextTicker = normalizeTicker(symbol);
      if (!isUsPeerTicker(nextTicker) || nextTicker === ticker) continue;
      const current = candidates.get(nextTicker) ?? { ticker: nextTicker, exchange: null, confidence: null, sources: new Set<PeerMembershipSource>() };
      current.sources.add(source);
      current.confidence = current.sources.size > 1 ? 1 : 0.6;
      candidates.set(nextTicker, current);
    }
  };
  register(finnhubPeers, "finnhub_seed");
  register(fmpPeers, "fmp_seed");

  if (candidates.size === 0 && fallbackOnEmpty) {
    if (providerMode === "finnhub" && env.FMP_API_KEY) {
      register(await fetchFmpPeers(ticker, env.FMP_API_KEY).catch(() => []), "fmp_seed");
    } else if (providerMode === "fmp" && env.FINNHUB_API_KEY) {
      register(await fetchFinnhubPeers(ticker, env.FINNHUB_API_KEY).catch(() => []), "finnhub_seed");
    }
  }

  await upsertSeedSymbol(env, rootProfile);

  const detail = await loadPeerTickerDetail(env, ticker);
  const groupId = await ensureSeedGroup(env, ticker, rootProfile, detail?.groups);

  await upsertTickerPeerMembership(env, {
    ticker,
    peerGroupId: groupId,
    source: "system",
    confidence: 1,
  });

  const insertedTickers: string[] = [];
  const sourceBreakdown: Record<string, number> = {};
  for (const candidate of candidates.values()) {
    const profile = await loadSeedProfile(candidate.ticker, env, {
      allowExternalLookup: enrichPeers,
      providers,
    });
    if (!profile) continue;
    if (!isUsPeerTicker(profile.ticker) || !isUsEquityExchange(profile.exchange)) continue;
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

export async function normalizeSeededPeerGroupLabels(
  env: Env,
  input?: { limit?: number | null },
): Promise<{ processed: number; renamed: number; merged: number; skipped: number }> {
  const limit = Math.max(1, Math.min(1000, Number(input?.limit ?? 250)));
  const rows = await env.DB.prepare(
    `SELECT id, slug, name
     FROM peer_groups
     WHERE group_type = 'fundamental'
       AND slug LIKE '%-fundamental-peers'
     ORDER BY created_at ASC, name ASC
     LIMIT ?`,
  ).bind(limit).all<{ id: string; slug: string; name: string }>();

  let processed = 0;
  let renamed = 0;
  let merged = 0;
  let skipped = 0;

  for (const group of rows.results ?? []) {
    processed += 1;
    const root = await env.DB.prepare(
      `SELECT ticker
       FROM ticker_peer_groups
       WHERE peer_group_id = ? AND source = 'system' AND confidence = 1
       ORDER BY created_at ASC, ticker ASC
       LIMIT 1`,
    ).bind(group.id).first<{ ticker: string }>();
    const rootTicker = root?.ticker?.toUpperCase() ?? group.slug.replace(/-fundamental-peers$/i, "").toUpperCase();
    if (!isValidBootstrapRootTicker(rootTicker)) {
      skipped += 1;
      continue;
    }

    const profile = await loadSeedProfile(rootTicker, env, {
      allowExternalLookup: true,
      providers: ["finnhub", "fmp"],
    });
    if (!profile) {
      skipped += 1;
      continue;
    }

    await upsertSeedSymbol(env, profile);
    const title = deriveSeedGroupTitle(profile, rootTicker);
    const targetSlug = deriveSeedGroupSlug(title, "fundamental");

    if (targetSlug === group.slug) {
      if (group.name !== title) {
        await updatePeerGroup(env, group.id, {
          name: title,
          slug: targetSlug,
          description: `Seeded fundamental peer group for ${title}.`,
        });
        renamed += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    const targetGroup = await env.DB.prepare(
      "SELECT id FROM peer_groups WHERE slug = ? LIMIT 1",
    ).bind(targetSlug).first<{ id: string }>();
    const targetGroupId = targetGroup?.id ?? (await createPeerGroup(env, {
      name: title,
      slug: targetSlug,
      groupType: "fundamental",
      description: `Seeded fundamental peer group for ${title}.`,
      priority: 100,
      isActive: true,
    })).id;

    const memberships = await env.DB.prepare(
      "SELECT ticker, source, confidence FROM ticker_peer_groups WHERE peer_group_id = ?",
    ).bind(group.id).all<{ ticker: string; source: PeerMembershipSource; confidence: number | null }>();

    for (const membership of memberships.results ?? []) {
      await upsertTickerPeerMembership(env, {
        ticker: membership.ticker,
        peerGroupId: targetGroupId,
        source: membership.source,
        confidence: typeof membership.confidence === "number" ? membership.confidence : null,
      });
      await removeTickerPeerMembership(env, group.id, membership.ticker);
    }

    await env.DB.prepare("DELETE FROM peer_groups WHERE id = ?").bind(group.id).run();
    merged += 1;
  }

  return { processed, renamed, merged, skipped };
}
