import { fetchTickerNews } from "./alerts-news";
import { classifyUsMarketSession, todayNyIso } from "./alerts-time";
import { getProvider } from "./provider";
import type { Env } from "./types";

const GAPPERS_SESSION = "premarket";
const SNAPSHOT_FRESH_MS = 45_000;
const RETENTION_DAYS = 1;
const DEFAULT_LIMIT = 25;
const MAX_UNIVERSE_SIZE = 2400;
const TRADINGVIEW_SCAN_URL = "https://scanner.tradingview.com/america/scan";
const TRADINGVIEW_FALLBACK_LABEL = "TradingView Screener (premarket fallback)";

export type GapperNewsItem = {
  headline: string;
  source: string;
  url: string;
  publishedAt: string | null;
  snippet: string | null;
};

export type GapperAnalysis = {
  summary: string;
  freshnessLabel: "fresh" | "stale" | "unclear";
  freshnessScore: number;
  impactLabel: "high" | "medium" | "low" | "noise";
  impactScore: number;
  liquidityRiskLabel: "normal" | "thin" | "likely-order-driven";
  liquidityRiskScore: number;
  compositeScore: number;
  reasoningBullets: string[];
  model: string;
};

export type GapperRow = {
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  price: number;
  prevClose: number;
  premarketPrice: number;
  gapPct: number;
  premarketVolume: number;
  news: GapperNewsItem[];
  analysis: GapperAnalysis | null;
  compositeScore: number | null;
};

export type GappersSnapshot = {
  id: string;
  marketSession: string;
  providerLabel: string;
  generatedAt: string;
  rowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
  warning: string | null;
  rows: GapperRow[];
};

type RankedGapCandidate = {
  ticker: string;
  price: number;
  prevClose: number;
  premarketPrice: number;
  premarketVolume: number;
  gapPct: number;
};

type TradingViewGapCandidate = RankedGapCandidate & {
  name: string | null;
  marketCap: number | null;
};

type LocalProfile = {
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isSnapshotFresh(generatedAt: string | null | undefined, now = Date.now()): boolean {
  if (!generatedAt) return false;
  const parsed = new Date(generatedAt).getTime();
  if (Number.isNaN(parsed)) return false;
  return now - parsed < SNAPSHOT_FRESH_MS;
}

function buildRankedGapCandidates(
  snapshots: Record<string, { price: number; prevClose: number; premarketPrice: number; premarketVolume: number }>,
  limit = DEFAULT_LIMIT,
): RankedGapCandidate[] {
  return Object.entries(snapshots)
    .map(([ticker, snapshot]) => {
      if (!snapshot.prevClose || !snapshot.premarketPrice) return null;
      const gapPct = ((snapshot.premarketPrice - snapshot.prevClose) / snapshot.prevClose) * 100;
      if (!Number.isFinite(gapPct) || gapPct <= 0) return null;
      return {
        ticker,
        price: snapshot.price,
        prevClose: snapshot.prevClose,
        premarketPrice: snapshot.premarketPrice,
        premarketVolume: snapshot.premarketVolume,
        gapPct,
      } satisfies RankedGapCandidate;
    })
    .filter((row): row is RankedGapCandidate => Boolean(row))
    .sort((a, b) => b.gapPct - a.gapPct)
    .slice(0, clamp(limit, 1, 100));
}

function parseTradingViewGapScan(
  payload: unknown,
  limit = DEFAULT_LIMIT,
): TradingViewGapCandidate[] {
  const rows = (payload as { data?: Array<{ s?: string; d?: unknown[] }> } | null)?.data ?? [];
  const out: TradingViewGapCandidate[] = [];
  for (const row of rows) {
    const symbol = String(row?.s ?? "").toUpperCase();
    const ticker = symbol.includes(":") ? symbol.split(":").pop() ?? "" : symbol;
    const data = Array.isArray(row?.d) ? row.d : [];
    const name = typeof data[0] === "string" ? data[0] : null;
    const prevClose = typeof data[1] === "number" && Number.isFinite(data[1]) ? data[1] : null;
    const marketCap = typeof data[3] === "number" && Number.isFinite(data[3]) ? data[3] : null;
    const premarketChangeAbs = typeof data[5] === "number" && Number.isFinite(data[5]) ? data[5] : null;
    const premarketVolume = typeof data[6] === "number" && Number.isFinite(data[6]) ? data[6] : 0;
    if (!ticker || prevClose == null || premarketChangeAbs == null) continue;
    const premarketPrice = prevClose + premarketChangeAbs;
    const gapPct = ((premarketPrice - prevClose) / prevClose) * 100;
    if (!Number.isFinite(premarketPrice) || premarketPrice <= 0 || !Number.isFinite(gapPct) || gapPct <= 0) continue;
    out.push({
      ticker,
      name,
      marketCap,
      price: premarketPrice,
      prevClose,
      premarketPrice,
      premarketVolume,
      gapPct,
    });
  }
  return out
    .sort((a, b) => b.gapPct - a.gapPct)
    .slice(0, clamp(limit, 1, 100));
}

async function fetchTradingViewPremarketGappers(limit = DEFAULT_LIMIT): Promise<TradingViewGapCandidate[]> {
  const response = await fetch(TRADINGVIEW_SCAN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://www.tradingview.com",
      Referer: "https://www.tradingview.com/",
      "User-Agent": "market-command-centre/1.0",
    },
    body: JSON.stringify({
      markets: ["america"],
      symbols: {
        query: { types: [] },
        tickers: [],
      },
      options: { lang: "en" },
      columns: [
        "name",
        "close",
        "volume",
        "market_cap_basic",
        "premarket_change",
        "premarket_change_abs",
        "premarket_volume",
        "premarket_gap",
      ],
      sort: {
        sortBy: "premarket_gap",
        sortOrder: "desc",
      },
      range: [0, clamp(limit * 3, 25, 200)],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`TradingView premarket scan failed (${response.status}): ${body.slice(0, 180)}`);
  }
  return parseTradingViewGapScan(await response.json(), limit);
}

function fallbackAnalysis(row: {
  ticker: string;
  gapPct: number;
  premarketVolume: number;
  news: GapperNewsItem[];
}): GapperAnalysis {
  const freshest = row.news
    .map((item) => (item.publishedAt ? new Date(item.publishedAt).getTime() : NaN))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];
  const ageMinutes = Number.isFinite(freshest) ? (Date.now() - freshest) / 60_000 : null;
  const fresh = ageMinutes != null && ageMinutes <= 180;
  const impactScore = row.news.length === 0 ? 20 : row.gapPct >= 10 ? 78 : row.gapPct >= 5 ? 62 : 45;
  const liquidityRiskScore = row.premarketVolume >= 1_000_000 ? 18 : row.premarketVolume >= 250_000 ? 42 : 76;
  const compositeScore = clamp(Math.round((impactScore * 0.55) + ((100 - liquidityRiskScore) * 0.45)), 0, 100);
  return {
    summary: row.news.length > 0
      ? `${row.ticker} is gapping ${row.gapPct.toFixed(2)}% with news coverage available; review headlines for catalyst confirmation.`
      : `${row.ticker} is gapping ${row.gapPct.toFixed(2)}% but there is limited supporting news; treat as potentially liquidity-driven.`,
    freshnessLabel: fresh ? "fresh" : row.news.length > 0 ? "stale" : "unclear",
    freshnessScore: fresh ? 82 : row.news.length > 0 ? 45 : 25,
    impactLabel: impactScore >= 70 ? "high" : impactScore >= 50 ? "medium" : row.news.length > 0 ? "low" : "noise",
    impactScore,
    liquidityRiskLabel: liquidityRiskScore >= 70 ? "likely-order-driven" : liquidityRiskScore >= 40 ? "thin" : "normal",
    liquidityRiskScore,
    compositeScore,
    reasoningBullets: [
      row.news.length > 0 ? `${row.news.length} relevant news item(s) were found.` : "No strong catalyst headline was found in the cached news set.",
      `Gap size is ${row.gapPct.toFixed(2)}%.`,
      `Premarket volume is ${Math.round(row.premarketVolume).toLocaleString()}.`,
    ],
    model: "rules",
  };
}

async function callOpenAiAnalyses(env: Env, rows: Array<{
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  price: number;
  prevClose: number;
  premarketPrice: number;
  gapPct: number;
  premarketVolume: number;
  news: GapperNewsItem[];
}>): Promise<Record<string, GapperAnalysis>> {
  const apiKey = env.OPENAI_API_KEY ?? "";
  if (!apiKey || rows.length === 0) return {};
  const model = env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const system = [
    "You are analyzing US premarket gapper stocks.",
    "Return strict JSON only.",
    "For each ticker provide: summary, freshnessLabel, freshnessScore, impactLabel, impactScore, liquidityRiskLabel, liquidityRiskScore, compositeScore, reasoningBullets.",
    "Use only the supplied data. Do not invent external facts.",
  ].join(" ");
  const user = JSON.stringify({
    marketSession: GAPPERS_SESSION,
    tickers: rows,
    responseShape: {
      analyses: [
        {
          ticker: "string",
          summary: "string",
          freshnessLabel: "fresh|stale|unclear",
          freshnessScore: "0-100",
          impactLabel: "high|medium|low|noise",
          impactScore: "0-100",
          liquidityRiskLabel: "normal|thin|likely-order-driven",
          liquidityRiskScore: "0-100",
          compositeScore: "0-100",
          reasoningBullets: ["string"],
        },
      ],
    },
  });
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI gap analysis failed (${response.status}): ${body.slice(0, 180)}`);
  }
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content ?? "";
  const parsed = parseJson<{ analyses?: Array<Record<string, unknown>> }>(content, { analyses: [] });
  const out: Record<string, GapperAnalysis> = {};
  for (const row of parsed.analyses ?? []) {
    const ticker = String(row.ticker ?? "").trim().toUpperCase();
    if (!ticker) continue;
    out[ticker] = {
      summary: String(row.summary ?? "").trim() || `${ticker} has no model summary.`,
      freshnessLabel: (["fresh", "stale", "unclear"].includes(String(row.freshnessLabel)) ? String(row.freshnessLabel) : "unclear") as GapperAnalysis["freshnessLabel"],
      freshnessScore: clamp(Number(row.freshnessScore ?? 0), 0, 100),
      impactLabel: (["high", "medium", "low", "noise"].includes(String(row.impactLabel)) ? String(row.impactLabel) : "noise") as GapperAnalysis["impactLabel"],
      impactScore: clamp(Number(row.impactScore ?? 0), 0, 100),
      liquidityRiskLabel: (["normal", "thin", "likely-order-driven"].includes(String(row.liquidityRiskLabel)) ? String(row.liquidityRiskLabel) : "thin") as GapperAnalysis["liquidityRiskLabel"],
      liquidityRiskScore: clamp(Number(row.liquidityRiskScore ?? 0), 0, 100),
      compositeScore: clamp(Number(row.compositeScore ?? 0), 0, 100),
      reasoningBullets: Array.isArray(row.reasoningBullets)
        ? row.reasoningBullets.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 4)
        : [],
      model,
    };
  }
  return out;
}

async function loadUniverseTickers(env: Env, maxTickers = MAX_UNIVERSE_SIZE): Promise<string[]> {
  const primary = await env.DB.prepare(
    "SELECT ticker FROM universe_symbols WHERE universe_id = ? ORDER BY ticker ASC LIMIT ?",
  )
    .bind("overall-market-proxy", maxTickers)
    .all<{ ticker: string }>();
  const primaryRows = (primary.results ?? []).map((row) => row.ticker.toUpperCase());
  if (primaryRows.length > 0) return primaryRows;
  const fallback = await env.DB.prepare(
    "SELECT ticker FROM symbols WHERE asset_class IN ('stock', 'equity', 'common-stock') ORDER BY ticker ASC LIMIT ?",
  )
    .bind(maxTickers)
    .all<{ ticker: string }>();
  return (fallback.results ?? []).map((row) => row.ticker.toUpperCase());
}

async function loadProfiles(env: Env, tickers: string[]): Promise<Map<string, LocalProfile>> {
  const unique = Array.from(new Set(tickers.map((ticker) => ticker.toUpperCase()).filter(Boolean)));
  if (unique.length === 0) return new Map();
  const profileMap = new Map<string, LocalProfile>();
  const chunkSize = 200;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT ticker, name, sector, industry FROM symbols WHERE ticker IN (${placeholders})`,
    )
      .bind(...chunk)
      .all<{ ticker: string; name: string | null; sector: string | null; industry: string | null }>();
    for (const row of rows.results ?? []) {
      profileMap.set(row.ticker.toUpperCase(), {
        ticker: row.ticker.toUpperCase(),
        name: row.name ?? null,
        sector: row.sector ?? null,
        industry: row.industry ?? null,
        marketCap: null,
      });
    }
  }
  return profileMap;
}

async function fetchYahooMarketCaps(tickers: string[]): Promise<Map<string, { marketCap: number | null; name: string | null }>> {
  const unique = Array.from(new Set(tickers.map((ticker) => ticker.toUpperCase()).filter(Boolean)));
  const map = new Map<string, { marketCap: number | null; name: string | null }>();
  const chunkSize = 50;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const params = new URLSearchParams({ symbols: chunk.join(",") });
    try {
      const response = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?${params.toString()}`, {
        headers: { "User-Agent": "market-command-centre/1.0" },
      });
      if (!response.ok) continue;
      const payload = await response.json() as {
        quoteResponse?: {
          result?: Array<{ symbol?: string; marketCap?: number; longName?: string; shortName?: string }>;
        };
      };
      for (const row of payload.quoteResponse?.result ?? []) {
        const ticker = String(row.symbol ?? "").toUpperCase();
        if (!ticker) continue;
        map.set(ticker, {
          marketCap: typeof row.marketCap === "number" && Number.isFinite(row.marketCap) ? row.marketCap : null,
          name: typeof row.longName === "string" ? row.longName : typeof row.shortName === "string" ? row.shortName : null,
        });
      }
    } catch {
      // Ignore metadata enrichment failures.
    }
  }
  return map;
}

async function latestStoredSnapshot(env: Env): Promise<GappersSnapshot | null> {
  const meta = await env.DB.prepare(
    "SELECT id, market_session as marketSession, provider_label as providerLabel, generated_at as generatedAt, row_count as rowCount, status, error FROM gappers_snapshots ORDER BY datetime(generated_at) DESC LIMIT 1",
  ).first<{
    id: string;
    marketSession: string;
    providerLabel: string;
    generatedAt: string;
    rowCount: number;
    status: "ok" | "warning" | "error" | "empty";
    error: string | null;
  }>();
  if (!meta?.id) return null;
  const rows = await env.DB.prepare(
    "SELECT ticker, name, sector, industry, market_cap as marketCap, price, prev_close as prevClose, premarket_price as premarketPrice, gap_pct as gapPct, premarket_volume as premarketVolume, news_json as newsJson, analysis_json as analysisJson, composite_score as compositeScore FROM gappers_rows WHERE snapshot_id = ? ORDER BY gap_pct DESC, ticker ASC",
  )
    .bind(meta.id)
    .all<any>();
  return {
    id: meta.id,
    marketSession: meta.marketSession,
    providerLabel: meta.providerLabel,
    generatedAt: meta.generatedAt,
    rowCount: meta.rowCount,
    status: meta.status,
    error: meta.error,
    warning: meta.status === "warning" ? meta.error : null,
    rows: (rows.results ?? []).map((row) => ({
      ticker: row.ticker,
      name: row.name ?? null,
      sector: row.sector ?? null,
      industry: row.industry ?? null,
      marketCap: row.marketCap ?? null,
      price: row.price,
      prevClose: row.prevClose,
      premarketPrice: row.premarketPrice,
      gapPct: row.gapPct,
      premarketVolume: row.premarketVolume,
      news: parseJson<GapperNewsItem[]>(row.newsJson, []),
      analysis: parseJson<GapperAnalysis | null>(row.analysisJson, null),
      compositeScore: row.compositeScore ?? null,
    })),
  };
}

export async function buildGappersSnapshot(env: Env, limit = DEFAULT_LIMIT): Promise<GappersSnapshot> {
  const provider = getProvider(env);
  const marketSession = classifyUsMarketSession(new Date());
  if (!provider.getPremarketSnapshot) {
    return {
      id: crypto.randomUUID(),
      marketSession: GAPPERS_SESSION,
      providerLabel: provider.label,
      generatedAt: new Date().toISOString(),
      rowCount: 0,
      status: "warning",
      error: "Active data provider does not expose premarket snapshot fields.",
      warning: "Active data provider does not expose premarket snapshot fields.",
      rows: [],
    };
  }

  const universe = await loadUniverseTickers(env);
  const snapshots = await provider.getPremarketSnapshot(universe);
  let ranked = buildRankedGapCandidates(snapshots, limit);
  let fallbackRows: TradingViewGapCandidate[] = [];
  let providerLabel = provider.label;
  if (ranked.length === 0) {
    try {
      fallbackRows = await fetchTradingViewPremarketGappers(limit);
      ranked = fallbackRows.map(({ name: _name, marketCap: _marketCap, ...row }) => row);
      if (fallbackRows.length > 0) providerLabel = `${provider.label} -> ${TRADINGVIEW_FALLBACK_LABEL}`;
    } catch (error) {
      console.error("tradingview premarket fallback failed", error);
    }
  }
  const profiles = await loadProfiles(env, ranked.map((row) => row.ticker));
  const marketCaps = await fetchYahooMarketCaps(ranked.map((row) => row.ticker));
  const fallbackMeta = new Map(fallbackRows.map((row) => [row.ticker, row] as const));
  const tradingDay = todayNyIso();
  const rowsBase = await Promise.all(
    ranked.map(async (row) => {
      const profile = profiles.get(row.ticker) ?? {
        ticker: row.ticker,
        name: null,
        sector: null,
        industry: null,
        marketCap: null,
      };
      const marketMeta = marketCaps.get(row.ticker);
      const fallbackMetaRow = fallbackMeta.get(row.ticker);
      const newsRes = await fetchTickerNews(env, row.ticker, tradingDay, 3);
      const news: GapperNewsItem[] = (newsRes.rows ?? []).map((item) => ({
        headline: item.headline,
        source: item.source,
        url: item.url,
        publishedAt: item.publishedAt,
        snippet: item.snippet,
      }));
      return {
        ticker: row.ticker,
        name: marketMeta?.name ?? profile.name ?? fallbackMetaRow?.name ?? row.ticker,
        sector: profile.sector ?? null,
        industry: profile.industry ?? null,
        marketCap: marketMeta?.marketCap ?? fallbackMetaRow?.marketCap ?? profile.marketCap ?? null,
        price: row.price,
        prevClose: row.prevClose,
        premarketPrice: row.premarketPrice,
        gapPct: row.gapPct,
        premarketVolume: row.premarketVolume,
        news,
      };
    }),
  );

  let analyses: Record<string, GapperAnalysis> = {};
  try {
    analyses = await callOpenAiAnalyses(env, rowsBase);
  } catch (error) {
    console.error("gappers openai analysis failed; using rules fallback", error);
  }

  const rows: GapperRow[] = rowsBase.map((row) => {
    const analysis = analyses[row.ticker] ?? fallbackAnalysis(row);
    return {
      ...row,
      analysis,
      compositeScore: analysis.compositeScore,
    };
  });

  const warning = rows.length > 0
    ? providerLabel !== provider.label
      ? `Alpaca premarket snapshots returned no ranked rows, so ${TRADINGVIEW_FALLBACK_LABEL} is being used.`
      : marketSession !== GAPPERS_SESSION
        ? `US market session is currently ${marketSession}; premarket ranking may be stale outside the premarket window.`
        : analyses && Object.keys(analyses).length === 0 && !(env.OPENAI_API_KEY ?? "")
          ? "OpenAI analysis is unavailable because OPENAI_API_KEY is not configured; rule-based scoring is shown."
          : null
    : marketSession !== GAPPERS_SESSION
      ? `US market session is currently ${marketSession}; premarket ranking may be unavailable outside the premarket window.`
      : "No ranked premarket rows were returned from Alpaca or the TradingView fallback source.";
  const status = rows.length === 0 ? "empty" : warning ? "warning" : "ok";
  return {
    id: crypto.randomUUID(),
    marketSession: GAPPERS_SESSION,
    providerLabel,
    generatedAt: new Date().toISOString(),
    rowCount: rows.length,
    status,
    error: warning,
    warning,
    rows,
  };
}

export async function persistGappersSnapshot(env: Env, snapshot: GappersSnapshot): Promise<void> {
  const statements = [
    env.DB.prepare(
      "INSERT INTO gappers_snapshots (id, market_session, provider_label, generated_at, row_count, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      snapshot.id,
      snapshot.marketSession,
      snapshot.providerLabel,
      snapshot.generatedAt,
      snapshot.rowCount,
      snapshot.status,
      snapshot.error,
    ),
    ...snapshot.rows.map((row) =>
      env.DB.prepare(
        "INSERT INTO gappers_rows (id, snapshot_id, ticker, name, sector, industry, market_cap, price, prev_close, premarket_price, gap_pct, premarket_volume, news_json, analysis_json, composite_score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        crypto.randomUUID(),
        snapshot.id,
        row.ticker,
        row.name,
        row.sector,
        row.industry,
        row.marketCap,
        row.price,
        row.prevClose,
        row.premarketPrice,
        row.gapPct,
        row.premarketVolume,
        toJson(row.news) ?? "[]",
        toJson(row.analysis),
        row.compositeScore,
        snapshot.generatedAt,
      ),
    ),
  ];
  await env.DB.batch(statements);
}

export async function cleanupOldGappersData(env: Env, retentionDays = RETENTION_DAYS): Promise<{ deletedSnapshots: number; deletedRows: number }> {
  const window = `-${Math.max(1, retentionDays)} day`;
  const deleteRows = await env.DB.prepare(
    "DELETE FROM gappers_rows WHERE datetime(created_at) < datetime('now', ?)",
  ).bind(window).run();
  const deleteSnapshots = await env.DB.prepare(
    "DELETE FROM gappers_snapshots WHERE datetime(generated_at) < datetime('now', ?)",
  ).bind(window).run();
  return {
    deletedSnapshots: deleteSnapshots.meta?.changes ?? 0,
    deletedRows: deleteRows.meta?.changes ?? 0,
  };
}

export async function getGappersSnapshot(env: Env, options?: { force?: boolean; limit?: number }): Promise<GappersSnapshot> {
  const force = options?.force === true;
  const cached = await latestStoredSnapshot(env);
  if (!force && cached && isSnapshotFresh(cached.generatedAt)) {
    return {
      ...cached,
      rows: cached.rows.slice(0, clamp(options?.limit ?? DEFAULT_LIMIT, 1, 100)),
      rowCount: Math.min(cached.rowCount, clamp(options?.limit ?? DEFAULT_LIMIT, 1, 100)),
    };
  }
  const snapshot = await buildGappersSnapshot(env, options?.limit ?? DEFAULT_LIMIT);
  await persistGappersSnapshot(env, snapshot);
  await cleanupOldGappersData(env, RETENTION_DAYS);
  return snapshot;
}

export async function refreshGappersSnapshot(env: Env, limit = DEFAULT_LIMIT): Promise<GappersSnapshot> {
  return getGappersSnapshot(env, { force: true, limit });
}

export { buildRankedGapCandidates, fallbackAnalysis, isSnapshotFresh, parseTradingViewGapScan };
