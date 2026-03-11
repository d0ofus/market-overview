import { classifyUsMarketSession } from "./alerts-time";
import type { Env } from "./types";

const GAPPERS_SESSION = "premarket";
const SNAPSHOT_FRESH_MS = 45_000;
const RETENTION_DAYS = 1;
const DEFAULT_LIMIT = 50;
const TV_SCAN_URL = "https://scanner.tradingview.com/america/scan";
const TV_PROVIDER_LABEL = "TradingView Screener (america/premarket_gappers)";
const MAX_FETCH_RANGE = 300;

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

export type LlmProviderName = "openai" | "anthropic";

export type GappersLlmConfig = {
  provider: LlmProviderName;
  apiKey: string;
  model: string;
  baseUrl: string | null;
};

export type GappersScanFilters = {
  limit: number;
  minMarketCap: number | null;
  maxMarketCap: number | null;
  industries: string[];
  minPrice: number | null;
  maxPrice: number | null;
  minGapPct: number | null;
  maxGapPct: number | null;
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

type TradingViewGapCandidate = {
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  price: number;
  prevClose: number;
  premarketPrice: number;
  premarketVolume: number;
  gapPct: number;
};

type TradingViewFilter = {
  left: string;
  operation: string;
  right: number | string | boolean | Array<number | string>;
};

type TradingViewScanPayload = {
  markets: string[];
  symbols: { query: { types: string[] }; tickers: string[] };
  options: { lang: string };
  columns: string[];
  sort: { sortBy: string; sortOrder: "asc" | "desc"; nullsFirst?: boolean };
  range: [number, number];
  filter: TradingViewFilter[];
};

const DEFAULT_SCAN_FILTERS: GappersScanFilters = {
  limit: DEFAULT_LIMIT,
  minMarketCap: null,
  maxMarketCap: null,
  industries: [],
  minPrice: null,
  maxPrice: null,
  minGapPct: null,
  maxGapPct: null,
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

function normalizeNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeIndustries(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

export function normalizeGappersScanFilters(input?: Partial<GappersScanFilters> | null): GappersScanFilters {
  const limit = clamp(Number(input?.limit ?? DEFAULT_SCAN_FILTERS.limit), 1, 100);
  return {
    limit,
    minMarketCap: normalizeNullableNumber(input?.minMarketCap),
    maxMarketCap: normalizeNullableNumber(input?.maxMarketCap),
    industries: normalizeIndustries(input?.industries),
    minPrice: normalizeNullableNumber(input?.minPrice),
    maxPrice: normalizeNullableNumber(input?.maxPrice),
    minGapPct: normalizeNullableNumber(input?.minGapPct),
    maxGapPct: normalizeNullableNumber(input?.maxGapPct),
  };
}

function inRangeFilter(left: string, min: number | null, max: number | null): TradingViewFilter[] {
  if (min != null && max != null) return [{ left, operation: "in_range", right: [min, max] }];
  if (min != null) return [{ left, operation: "egreater", right: min }];
  if (max != null) return [{ left, operation: "less", right: max }];
  return [];
}

export function buildTradingViewPremarketPayload(filtersInput?: Partial<GappersScanFilters> | null): TradingViewScanPayload {
  const filters = normalizeGappersScanFilters(filtersInput);
  const rawLimit = filters.industries.length > 0
    ? clamp(Math.max(filters.limit * 3, 100), filters.limit, MAX_FETCH_RANGE)
    : filters.limit;
  return {
    markets: ["america"],
    symbols: { query: { types: [] }, tickers: [] },
    options: { lang: "en" },
    columns: [
      "name",
      "sector",
      "industry",
      "market_cap_basic",
      "close",
      "premarket_change",
      "premarket_change_abs",
      "premarket_close",
      "premarket_gap",
      "premarket_volume",
    ],
    sort: { sortBy: "premarket_gap", sortOrder: "desc" },
    range: [0, rawLimit],
    filter: [
      { left: "premarket_gap", operation: "greater", right: 0 },
      ...inRangeFilter("market_cap_basic", filters.minMarketCap, filters.maxMarketCap),
      ...inRangeFilter("close", filters.minPrice, filters.maxPrice),
      ...inRangeFilter("premarket_gap", filters.minGapPct, filters.maxGapPct),
    ],
  };
}

function parseTradingViewTicker(value: unknown): string {
  const raw = String(value ?? "").trim().toUpperCase();
  if (!raw) return "";
  const parts = raw.split(":");
  return parts[parts.length - 1] ?? raw;
}

function rowMatchesIndustry(row: { industry: string | null }, industries: string[]): boolean {
  if (industries.length === 0) return true;
  const current = String(row.industry ?? "").trim().toLowerCase();
  return current.length > 0 && industries.some((value) => value.toLowerCase() === current);
}

async function fetchTradingViewGapCandidates(filtersInput?: Partial<GappersScanFilters> | null): Promise<TradingViewGapCandidate[]> {
  const filters = normalizeGappersScanFilters(filtersInput);
  const payload = buildTradingViewPremarketPayload(filters);
  const response = await fetch(TV_SCAN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "market-command-centre/1.0",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`TradingView gappers request failed (${response.status}): ${body.slice(0, 180)}`);
  }
  const parsed = await response.json() as {
    data?: Array<{ s?: string; d?: unknown[] }>;
  };
  return (parsed.data ?? [])
    .map((entry) => {
      const data = Array.isArray(entry.d) ? entry.d : [];
      const ticker = parseTradingViewTicker(entry.s);
      const name = typeof data[0] === "string" ? data[0] : null;
      const sector = typeof data[1] === "string" ? data[1] : null;
      const industry = typeof data[2] === "string" ? data[2] : null;
      const marketCap = normalizeNullableNumber(data[3]);
      const price = normalizeNullableNumber(data[4]);
      const premarketChangeAbs = normalizeNullableNumber(data[6]);
      const premarketClose = normalizeNullableNumber(data[7]);
      const gapPct = normalizeNullableNumber(data[8]);
      const premarketVolume = normalizeNullableNumber(data[9]) ?? 0;
      const prevClose = price;
      const premarketPrice = premarketClose ?? (price != null && premarketChangeAbs != null ? price + premarketChangeAbs : null);
      if (!ticker || price == null || prevClose == null || premarketPrice == null || gapPct == null) return null;
      return {
        ticker,
        name,
        sector,
        industry,
        marketCap,
        price,
        prevClose,
        premarketPrice,
        premarketVolume,
        gapPct,
      } satisfies TradingViewGapCandidate;
    })
    .filter((row): row is TradingViewGapCandidate => Boolean(row))
    .filter((row) => row.gapPct > 0)
    .filter((row) => rowMatchesIndustry(row, filters.industries))
    .slice(0, filters.limit);
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

async function callOpenAiAnalyses(
  config: GappersLlmConfig,
  rows: Array<{
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
  }>,
): Promise<Record<string, GapperAnalysis>> {
  if (!config.apiKey || rows.length === 0) return {};
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
  const response = await fetch(`${config.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
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
      model: `openai:${config.model}`,
    };
  }
  return out;
}

async function callAnthropicAnalyses(
  config: GappersLlmConfig,
  rows: Array<{
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
  }>,
): Promise<Record<string, GapperAnalysis>> {
  if (!config.apiKey || rows.length === 0) return {};
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
  const response = await fetch(`${config.baseUrl ?? "https://api.anthropic.com/v1"}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 1800,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic gap analysis failed (${response.status}): ${body.slice(0, 180)}`);
  }
  const payload = await response.json() as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = payload.content?.find((item) => item.type === "text")?.text ?? "";
  const parsed = parseJson<{ analyses?: Array<Record<string, unknown>> }>(text, { analyses: [] });
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
      model: `anthropic:${config.model}`,
    };
  }
  return out;
}

function resolveLlmConfig(env: Env, override?: Partial<GappersLlmConfig> | null): GappersLlmConfig | null {
  const providerRaw = String(override?.provider ?? env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? "anthropic" : "openai")).trim().toLowerCase();
  const provider = providerRaw === "anthropic" ? "anthropic" : providerRaw === "openai" ? "openai" : null;
  if (!provider) return null;
  const apiKey = String(
    override?.apiKey
      ?? env.LLM_API_KEY
      ?? (provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY)
      ?? "",
  ).trim();
  if (!apiKey) return null;
  const model = String(
    override?.model
      ?? env.LLM_MODEL
      ?? (provider === "anthropic" ? "claude-3-5-sonnet-latest" : env.OPENAI_MODEL ?? "gpt-4.1-mini"),
  ).trim();
  const baseUrl = String(override?.baseUrl ?? env.LLM_BASE_URL ?? "").trim() || null;
  return { provider, apiKey, model, baseUrl };
}

function expectedModelTag(config: GappersLlmConfig | null): string | null {
  if (!config) return null;
  return `${config.provider}:${config.model}`;
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

export async function buildGappersSnapshot(
  env: Env,
  limit = DEFAULT_LIMIT,
  llmOverride?: Partial<GappersLlmConfig> | null,
  filtersInput?: Partial<GappersScanFilters> | null,
): Promise<GappersSnapshot> {
  const llmConfig = resolveLlmConfig(env, llmOverride);
  const marketSession = classifyUsMarketSession(new Date());
  const filters = normalizeGappersScanFilters({ ...filtersInput, limit });
  const ranked = await fetchTradingViewGapCandidates(filters);
  const rowsBase = ranked.map((row) => ({
    ticker: row.ticker,
    name: row.name ?? row.ticker,
    sector: row.sector ?? null,
    industry: row.industry ?? null,
    marketCap: row.marketCap ?? null,
    price: row.price,
    prevClose: row.prevClose,
    premarketPrice: row.premarketPrice,
    gapPct: row.gapPct,
    premarketVolume: row.premarketVolume,
    news: [] as GapperNewsItem[],
  }));

  let analyses: Record<string, GapperAnalysis> = {};
  if (llmConfig) {
    try {
      analyses = llmConfig.provider === "anthropic"
        ? await callAnthropicAnalyses(llmConfig, rowsBase)
        : await callOpenAiAnalyses(llmConfig, rowsBase);
    } catch (error) {
      console.error("gappers llm analysis failed; using rules fallback", error);
    }
  }

  const rows: GapperRow[] = rowsBase.map((row) => {
    const analysis = analyses[row.ticker] ?? fallbackAnalysis(row);
    return {
      ...row,
      analysis,
      compositeScore: analysis.compositeScore,
    };
  });

  const warning = marketSession !== GAPPERS_SESSION
    ? `US market session is currently ${marketSession}; premarket ranking may be stale outside the premarket window.`
    : null;
  const status = rows.length === 0 ? "empty" : warning ? "warning" : "ok";
  return {
    id: crypto.randomUUID(),
    marketSession: GAPPERS_SESSION,
    providerLabel: TV_PROVIDER_LABEL,
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

function usesDefaultScanFilters(filters: GappersScanFilters): boolean {
  return JSON.stringify(filters) === JSON.stringify(DEFAULT_SCAN_FILTERS);
}

export async function getGappersSnapshot(
  env: Env,
  options?: { force?: boolean; limit?: number; llmConfig?: Partial<GappersLlmConfig> | null; filters?: Partial<GappersScanFilters> | null },
): Promise<GappersSnapshot> {
  const force = options?.force === true;
  const filters = normalizeGappersScanFilters({ ...options?.filters, limit: options?.limit ?? DEFAULT_LIMIT });
  const cached = await latestStoredSnapshot(env);
  const requestedModelTag = expectedModelTag(resolveLlmConfig(env, options?.llmConfig));
  const cachedModelTag = cached?.rows.find((row) => row.analysis?.model)?.analysis?.model ?? null;
  const cacheMatchesLlm = !requestedModelTag || !cachedModelTag || requestedModelTag === cachedModelTag;
  if (!force && usesDefaultScanFilters(filters) && cached && cacheMatchesLlm && isSnapshotFresh(cached.generatedAt)) {
    return {
      ...cached,
      rows: cached.rows.slice(0, filters.limit),
      rowCount: Math.min(cached.rowCount, filters.limit),
    };
  }
  const snapshot = await buildGappersSnapshot(env, filters.limit, options?.llmConfig, filters);
  await persistGappersSnapshot(env, snapshot);
  await cleanupOldGappersData(env, RETENTION_DAYS);
  return snapshot;
}

export async function refreshGappersSnapshot(
  env: Env,
  limit = DEFAULT_LIMIT,
  llmConfig?: Partial<GappersLlmConfig> | null,
  filters?: Partial<GappersScanFilters> | null,
): Promise<GappersSnapshot> {
  return getGappersSnapshot(env, { force: true, limit, llmConfig, filters });
}

export { fallbackAnalysis, isSnapshotFresh, resolveLlmConfig, fetchTradingViewGapCandidates };
