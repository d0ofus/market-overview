import { NextResponse } from "next/server";
import type { Browser, BrowserContext, Page, Response as PlaywrightResponse } from "playwright-core";
import {
  browserbaseConfigured,
  launchPerplexityBrowser,
  selectPerplexityBrowserProvider,
  type PerplexityBrowserProvider,
} from "@/lib/perplexity-browser-provider";
import {
  analyzePerplexityBodyText,
  emptyCompany,
  isSecurityVerificationText,
  mergeCompany,
  normalizeTicker,
  parseCompanyFromText,
  parseJsonPayload,
  parsePeersFromText,
  parsePeersPresetPayload,
  parseProfileDescriptionPayload,
  parseProfilePayload,
  type PerplexityFinanceBodyState,
  type PerplexityFinanceCompany,
  type PerplexityFinanceLookupStatus,
  type PerplexityFinancePeer,
} from "@/lib/perplexity-finance-parser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

const DEFAULT_TIMEOUT_MS = 24_000;
const CACHE_API_TIMEOUT_MS = 2_000;
const WORKER_API_BASE = process.env.PERPLEXITY_CACHE_API_BASE ?? process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8787";
const WORKER_ADMIN_SECRET = process.env.PERPLEXITY_CACHE_ADMIN_SECRET ?? process.env.ADMIN_SECRET ?? "";

type CacheMode = "hit" | "miss" | "refresh" | "stale_on_error";

type CacheMetadata = {
  mode: CacheMode;
  storedAt: string | null;
  ageSeconds: number | null;
};

type PerplexityFinanceResponsePayload = {
  ticker: string;
  fetchedAt: string;
  source: "perplexity_finance_dashboard";
  provider?: PerplexityBrowserProvider;
  browserbaseConfigured?: boolean;
  browserbaseSessionId?: string;
  browserbaseSessionUrl?: string;
  peersUrl: string;
  profileUrl: string;
  company: PerplexityFinanceCompany;
  peers: PerplexityFinancePeer[];
  warning: string | null;
  status: PerplexityFinanceLookupStatus;
  profileStatus: PerplexityFinanceLookupStatus;
  peersStatus: PerplexityFinanceLookupStatus;
  cache?: CacheMetadata;
  diagnostics?: {
    profileSource: string | null;
    peersSource: string | null;
    profileHttpStatus: number | null;
    peersHttpStatus: number | null;
    profileBodyState: string | null;
    peersBodyState: string | null;
    profileTimedOut: boolean;
    peersTimedOut: boolean;
    observedEndpoints: string[];
    blockedEndpoints: string[];
    providerWarning?: string | null;
  };
};

type WorkerCacheReadResult =
  | {
    hit: true;
    lookup: PerplexityFinanceResponsePayload;
    storedAt: string;
    ageSeconds: number | null;
  }
  | {
    hit: false;
    warning?: string;
  };

type CapturedJson = {
  payload: unknown;
  status: number;
  url: string;
};

type FinanceJsonCollector = {
  profile: CapturedJson | null;
  profileDescription: CapturedJson | null;
  peers: CapturedJson | null;
  peersSummary: CapturedJson | null;
  observedEndpoints: string[];
  blockedEndpoints: string[];
  drain: () => Promise<void>;
  stop: () => void;
  setProfile: (capture: CapturedJson) => void;
  setProfileDescription: (capture: CapturedJson) => void;
  setPeers: (capture: CapturedJson) => void;
};

type WaitResult = {
  bodyText: string;
  bodyState: PerplexityFinanceBodyState;
  timedOut: boolean;
};

type ExtractCompanyResult = {
  company: PerplexityFinanceCompany;
  peersHint: PerplexityFinancePeer[];
  peersHintSource: string | null;
  peersHintHttpStatus: number | null;
  status: PerplexityFinanceLookupStatus;
  source: string | null;
  httpStatus: number | null;
  bodyState: PerplexityFinanceBodyState;
  timedOut: boolean;
  observedEndpoints: string[];
  blockedEndpoints: string[];
};

type ExtractPeersResult = {
  peers: PerplexityFinancePeer[];
  status: PerplexityFinanceLookupStatus;
  source: string | null;
  httpStatus: number | null;
  bodyState: PerplexityFinanceBodyState;
  timedOut: boolean;
  observedEndpoints: string[];
  blockedEndpoints: string[];
};

function buildPerplexityUrls(ticker: string) {
  const peersUrl = new URL("https://www.perplexity.ai/finance/lists");
  peersUrl.searchParams.set("preset", "peers");
  peersUrl.searchParams.set("symbol", ticker);
  return {
    peersUrl: peersUrl.toString(),
    profileUrl: `https://www.perplexity.ai/finance/${encodeURIComponent(ticker)}`,
  };
}

function timeoutMs(): number {
  const parsed = Number(process.env.PERPLEXITY_FINANCE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(parsed) ? Math.max(8_000, Math.min(35_000, parsed)) : DEFAULT_TIMEOUT_MS;
}

function relevantEndpointLabel(responseUrl: URL, status: number): string | null {
  if (responseUrl.hostname !== "www.perplexity.ai") return null;
  if (!responseUrl.pathname.startsWith("/rest/finance") && !responseUrl.pathname.startsWith("/cdn-cgi")) return null;
  return `${status} ${responseUrl.pathname}${responseUrl.search}`;
}

function isPeersPresetUrl(responseUrl: URL, ticker: string): boolean {
  return (
    responseUrl.pathname === "/rest/finance/lists/preset"
    && responseUrl.searchParams.get("preset") === "peers"
    && responseUrl.searchParams.get("symbol")?.toUpperCase() === ticker
  );
}

function isPeersSummaryUrl(responseUrl: URL, ticker: string): boolean {
  return (
    responseUrl.pathname === "/rest/finance/lists/preset/summary"
    && responseUrl.searchParams.get("preset") === "peers"
    && responseUrl.searchParams.get("symbol")?.toUpperCase() === ticker
  );
}

function isTickerPeersUrl(responseUrl: URL, ticker: string): boolean {
  return responseUrl.pathname === `/rest/finance/peers/${ticker}`;
}

function createFinanceJsonCollector(page: Page, ticker: string): FinanceJsonCollector {
  const pending = new Set<Promise<void>>();
  const collector = {
    profile: null as CapturedJson | null,
    profileDescription: null as CapturedJson | null,
    peers: null as CapturedJson | null,
    peersSummary: null as CapturedJson | null,
    observedEndpoints: [] as string[],
    blockedEndpoints: [] as string[],
  };

  const recordEndpoint = (label: string | null) => {
    if (!label || collector.observedEndpoints.includes(label) || collector.observedEndpoints.length >= 32) return;
    collector.observedEndpoints.push(label);
  };

  const recordBlocked = (url: string) => {
    if (!collector.blockedEndpoints.includes(url) && collector.blockedEndpoints.length < 12) {
      collector.blockedEndpoints.push(url);
    }
  };

  const handleResponse = (response: PlaywrightResponse) => {
    let read: Promise<void>;
    read = (async () => {
      let responseUrl: URL;
      try {
        responseUrl = new URL(response.url());
      } catch {
        return;
      }

      const status = response.status();
      const label = relevantEndpointLabel(responseUrl, status);
      recordEndpoint(label);
      if (!label) return;

      const contentType = response.headers()["content-type"] ?? "";
      if (!contentType.includes("json") && status !== 403) return;

      let text = "";
      try {
        text = await response.text();
      } catch {
        return;
      }

      if (status === 403 || isSecurityVerificationText(text)) {
        recordBlocked(responseUrl.pathname);
        return;
      }

      const payload = parseJsonPayload(text);
      if (payload == null) return;
      const capture = { payload, status, url: response.url() };
      if (responseUrl.pathname === `/rest/finance/profile/${ticker}`) {
        collector.profile = capture;
      } else if (responseUrl.pathname === `/rest/finance/profile/${ticker}/description`) {
        collector.profileDescription = capture;
      } else if (isPeersPresetUrl(responseUrl, ticker)) {
        collector.peers = capture;
      } else if (isTickerPeersUrl(responseUrl, ticker) && !collector.peers) {
        collector.peers = capture;
      } else if (isPeersSummaryUrl(responseUrl, ticker)) {
        collector.peersSummary = capture;
      }
    })().finally(() => pending.delete(read));
    pending.add(read);
  };

  page.on("response", handleResponse);

  return {
    get profile() {
      return collector.profile;
    },
    get profileDescription() {
      return collector.profileDescription;
    },
    get peers() {
      return collector.peers;
    },
    get peersSummary() {
      return collector.peersSummary;
    },
    get observedEndpoints() {
      return collector.observedEndpoints;
    },
    get blockedEndpoints() {
      return collector.blockedEndpoints;
    },
    async drain() {
      while (pending.size > 0) {
        await Promise.allSettled(Array.from(pending));
      }
    },
    stop() {
      page.off("response", handleResponse);
    },
    setProfile(capture: CapturedJson) {
      collector.profile = capture;
    },
    setProfileDescription(capture: CapturedJson) {
      collector.profileDescription = capture;
    },
    setPeers(capture: CapturedJson) {
      collector.peers = capture;
    },
  };
}

async function clickCookieChoice(page: Page): Promise<void> {
  const clickVisibleChoice = () => page.evaluate(() => {
    const labels = new Set(["Only necessary", "Necessary only", "Allow all"]);
    const candidates = Array.from(document.querySelectorAll("button"));
    const button = candidates.find((candidate) => labels.has(candidate.textContent?.trim() ?? ""));
    button?.click();
  }).catch(() => undefined);
  await clickVisibleChoice();
  await page.waitForTimeout(250).catch(() => undefined);
  await clickVisibleChoice();
}

async function gotoAndPrime(page: Page, url: string, timeout: number): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await clickCookieChoice(page);
  await page.waitForLoadState("load", { timeout: Math.min(1_000, timeout) }).catch(() => undefined);
}

async function readBodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
}

async function waitForSignals(
  page: Page,
  collector: FinanceJsonCollector,
  ticker: string,
  kind: "profile" | "peers",
  timeout: number,
): Promise<WaitResult> {
  const deadline = Date.now() + timeout;
  let bodyText = "";
  let bodyState: PerplexityFinanceBodyState = "unknown";

  while (Date.now() < deadline) {
    await collector.drain();
    bodyText = await readBodyText(page);
    bodyState = analyzePerplexityBodyText(bodyText);
    if (bodyState === "blocked" || bodyState === "not_found") {
      return { bodyText, bodyState, timedOut: false };
    }
    if (kind === "profile" && (collector.profile || collector.profileDescription || parseCompanyFromText(bodyText, ticker).description)) {
      return { bodyText, bodyState, timedOut: false };
    }
    if (kind === "peers" && (collector.peers || parsePeersFromText(bodyText, ticker).length > 0)) {
      return { bodyText, bodyState, timedOut: false };
    }
    await page.waitForTimeout(500);
  }

  await collector.drain();
  bodyText = await readBodyText(page);
  bodyState = analyzePerplexityBodyText(bodyText);
  return { bodyText, bodyState, timedOut: true };
}

async function fetchSameOriginJson(page: Page, path: string): Promise<CapturedJson | null> {
  const result = await page.evaluate(async (endpoint) => {
    const response = await fetch(endpoint, { headers: { accept: "application/json" } });
    const text = await response.text();
    return {
      status: response.status,
      url: response.url,
      contentType: response.headers.get("content-type") ?? "",
      text,
    };
  }, path).catch(() => null);

  if (!result || result.status === 403 || isSecurityVerificationText(result.text) || !result.contentType.includes("json")) {
    return null;
  }
  const payload = parseJsonPayload(result.text);
  return payload == null ? null : { payload, status: result.status, url: result.url };
}

function companyStatus(company: PerplexityFinanceCompany, wait: WaitResult, collector: FinanceJsonCollector): PerplexityFinanceLookupStatus {
  const hasCompanyData = Boolean(company.name || company.exchange || company.sector || company.industry || company.description);
  if (hasCompanyData && company.description) return "ready";
  if (hasCompanyData) return "partial";
  if (wait.bodyState === "blocked" || collector.blockedEndpoints.length > 0) return "blocked";
  if (wait.bodyState === "not_found") return "not_found";
  if (wait.timedOut || wait.bodyState === "pending") return "pending_timeout";
  return "parse_error";
}

function peersStatus(peers: PerplexityFinancePeer[], wait: WaitResult, collector: FinanceJsonCollector): PerplexityFinanceLookupStatus {
  if (peers.length > 0) return "ready";
  if (wait.bodyState === "blocked" || collector.blockedEndpoints.length > 0) return "blocked";
  if (wait.bodyState === "not_found") return "not_found";
  if (wait.timedOut || wait.bodyState === "pending") return "pending_timeout";
  return "parse_error";
}

async function extractCompany(context: BrowserContext, ticker: string, profileUrl: string): Promise<ExtractCompanyResult> {
  const page = await context.newPage();
  const collector = createFinanceJsonCollector(page, ticker);
  try {
    const timeout = Math.min(9_000, timeoutMs());
    await gotoAndPrime(page, profileUrl, timeout);

    const [descriptionCapture, profileCapture, peersCapture] = await Promise.all([
      fetchSameOriginJson(page, `/rest/finance/profile/${encodeURIComponent(ticker)}/description`),
      fetchSameOriginJson(page, `/rest/finance/profile/${encodeURIComponent(ticker)}`),
      fetchSameOriginJson(page, `/rest/finance/peers/${encodeURIComponent(ticker)}`),
    ]);
    if (descriptionCapture) collector.setProfileDescription(descriptionCapture);
    if (profileCapture) collector.setProfile(profileCapture);
    if (peersCapture) collector.setPeers(peersCapture);

    const wait = await waitForSignals(page, collector, ticker, "profile", timeout);
    const description = parseProfileDescriptionPayload(collector.profileDescription?.payload);
    const profileCompany = parseProfilePayload(collector.profile?.payload);
    const domCompany = parseCompanyFromText(wait.bodyText, ticker);
    const company = mergeCompany(
      { description },
      profileCompany,
      domCompany,
    );
    const peersHint = parsePeersPresetPayload(collector.peers?.payload, ticker);
    const status = companyStatus(company, wait, collector);
    return {
      company,
      peersHint,
      peersHintSource: peersHint.length > 0 ? "/rest/finance/peers/{ticker}" : null,
      peersHintHttpStatus: peersHint.length > 0 ? collector.peers?.status ?? null : null,
      status,
      source: description
        ? "/rest/finance/profile/{ticker}/description"
        : collector.profile
          ? "/rest/finance/profile/{ticker}"
          : company.description
            ? "dom"
            : null,
      httpStatus: collector.profileDescription?.status ?? collector.profile?.status ?? null,
      bodyState: wait.bodyState,
      timedOut: wait.timedOut,
      observedEndpoints: [...collector.observedEndpoints],
      blockedEndpoints: [...collector.blockedEndpoints],
    };
  } finally {
    collector.stop();
    await page.close().catch(() => undefined);
  }
}

async function extractPeers(context: BrowserContext, ticker: string, peersUrl: string): Promise<ExtractPeersResult> {
  const page = await context.newPage();
  const collector = createFinanceJsonCollector(page, ticker);
  try {
    const timeout = Math.min(24_000, timeoutMs());
    await gotoAndPrime(page, peersUrl, timeout);
    const wait = await waitForSignals(page, collector, ticker, "peers", timeout);
    const peersFromJson = parsePeersPresetPayload(collector.peers?.payload, ticker);
    const peers = wait.bodyState === "blocked"
      ? []
      : peersFromJson.length > 0
        ? peersFromJson
        : parsePeersFromText(wait.bodyText, ticker);
    const status = peersStatus(peers, wait, collector);
    return {
      peers,
      status,
      source: peersFromJson.length > 0 ? "/rest/finance/lists/preset" : peers.length > 0 ? "dom" : null,
      httpStatus: collector.peers?.status ?? null,
      bodyState: wait.bodyState,
      timedOut: wait.timedOut,
      observedEndpoints: [...collector.observedEndpoints],
      blockedEndpoints: [...collector.blockedEndpoints],
    };
  } finally {
    collector.stop();
    await page.close().catch(() => undefined);
  }
}

function overallStatus(
  company: PerplexityFinanceCompany,
  peers: PerplexityFinancePeer[],
  profileStatus: PerplexityFinanceLookupStatus,
  peerStatus: PerplexityFinanceLookupStatus,
): PerplexityFinanceLookupStatus {
  if (company.description && peers.length > 0) return "ready";
  if (profileStatus === "blocked" && peerStatus === "blocked") return "blocked";
  if (peerStatus === "blocked" && !company.description) return "blocked";
  if (profileStatus === "not_found" && peerStatus === "not_found") return "not_found";
  if (peerStatus === "pending_timeout" && peers.length === 0) return "pending_timeout";
  if (company.description || company.name || peers.length > 0) return "partial";
  if (profileStatus === "blocked" || peerStatus === "blocked") return "blocked";
  if (profileStatus === "pending_timeout" || peerStatus === "pending_timeout") return "pending_timeout";
  return "parse_error";
}

function warningFor(
  status: PerplexityFinanceLookupStatus,
  profileStatus: PerplexityFinanceLookupStatus,
  peerStatus: PerplexityFinanceLookupStatus,
  company: PerplexityFinanceCompany,
  peers: PerplexityFinancePeer[],
  provider: PerplexityBrowserProvider,
  hasBrowserbaseConfig: boolean,
): string | null {
  const warnings: string[] = [];
  if (status === "blocked" || profileStatus === "blocked" || peerStatus === "blocked") {
    warnings.push("Perplexity blocked the browser session before all finance data could be read.");
    if (provider === "browserbase" && hasBrowserbaseConfig) {
      warnings.push("Open a Browserbase verification session, complete any Perplexity check, then Refresh.");
    } else if (!hasBrowserbaseConfig) {
      warnings.push("Browserbase is not configured, so the lookup used local Chromium without a persistent verification context.");
    }
  }
  if (peerStatus === "pending_timeout") {
    warnings.push("Perplexity was still generating the peers list when the lookup timed out. Try Refresh.");
  }
  if (profileStatus === "not_found" && !company.name) {
    warnings.push("Perplexity did not return a profile page for this ticker.");
  } else if (!company.description) {
    warnings.push("Company profile description was unavailable from Perplexity Finance.");
  }
  if (peers.length === 0 && peerStatus !== "blocked" && peerStatus !== "pending_timeout") {
    warnings.push("No peer JSON or table rows were parseable from the Perplexity Finance peers dashboard.");
  }
  const uniqueWarnings = Array.from(new Set(warnings));
  return uniqueWarnings.length > 0 ? uniqueWarnings.join(" ") : null;
}

function combineWarnings(...warnings: Array<string | null | undefined>): string | null {
  const pieces = warnings
    .flatMap((warning) => warning ? warning.split(/(?<=\.)\s+/) : [])
    .map((warning) => warning.trim())
    .filter(Boolean);
  const uniqueWarnings = Array.from(new Set(pieces));
  return uniqueWarnings.length > 0 ? uniqueWarnings.join(" ") : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Perplexity Finance extraction failed.";
}

function appendWarning(existing: string | null, next: string): string {
  return [existing, next].filter(Boolean).join(" ");
}

function cacheControlFor(): string {
  return "no-store";
}

function ageSeconds(storedAt: string | null): number | null {
  if (!storedAt) return null;
  const parsed = Date.parse(storedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
}

function withCache(payload: PerplexityFinanceResponsePayload, cache: CacheMetadata): PerplexityFinanceResponsePayload {
  return {
    ...payload,
    cache,
  };
}

async function fetchJsonWithTimeout<T>(url: string, init?: RequestInit, timeout = CACHE_API_TIMEOUT_MS): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadCachedLookup(ticker: string): Promise<WorkerCacheReadResult | null> {
  return fetchJsonWithTimeout<WorkerCacheReadResult>(
    `${WORKER_API_BASE}/api/perplexity-finance/cache/${encodeURIComponent(ticker)}`,
  );
}

async function storeCachedLookup(ticker: string, payload: PerplexityFinanceResponsePayload): Promise<void> {
  const headers: Record<string, string> = {};
  if (WORKER_ADMIN_SECRET) headers.Authorization = `Bearer ${WORKER_ADMIN_SECRET}`;
  await fetchJsonWithTimeout(
    `${WORKER_API_BASE}/api/admin/perplexity-finance/cache/${encodeURIComponent(ticker)}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
    },
  );
}

async function runLiveLookup(ticker: string): Promise<PerplexityFinanceResponsePayload> {
  const { peersUrl, profileUrl } = buildPerplexityUrls(ticker);
  const fetchedAt = new Date().toISOString();
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  try {
    const launched = await launchPerplexityBrowser();
    browser = launched.browser;
    context = launched.context;
    const companyResult = await extractCompany(context, ticker, profileUrl);
    const peersResult = companyResult.peersHint.length > 0
      ? null
      : await extractPeers(context, ticker, peersUrl);

    const peers = companyResult.peersHint.length > 0 ? companyResult.peersHint : peersResult?.peers ?? [];
    const effectivePeersStatus: PerplexityFinanceLookupStatus = companyResult.peersHint.length > 0
      ? "ready"
      : peersResult && peersResult.peers.length > 0
        ? peersResult.status
        : peersResult?.status ?? "parse_error";
    const peersSource = companyResult.peersHint.length > 0
      ? companyResult.peersHintSource
      : peersResult?.source ?? null;
    const peersHttpStatus = companyResult.peersHint.length > 0
      ? companyResult.peersHintHttpStatus
      : peersResult?.httpStatus ?? null;
    const status = overallStatus(companyResult.company, peers, companyResult.status, effectivePeersStatus);
    const warning = combineWarnings(
      launched.providerWarning,
      warningFor(
        status,
        companyResult.status,
        effectivePeersStatus,
        companyResult.company,
        peers,
        launched.provider,
        launched.browserbaseConfigured,
      ),
    );

    return {
      ticker,
      fetchedAt,
      source: "perplexity_finance_dashboard",
      provider: launched.provider,
      browserbaseConfigured: launched.browserbaseConfigured,
      browserbaseSessionId: launched.browserbaseSessionId,
      browserbaseSessionUrl: launched.browserbaseSessionUrl,
      peersUrl,
      profileUrl,
      company: companyResult.company,
      peers,
      warning,
      status,
      profileStatus: companyResult.status,
      peersStatus: effectivePeersStatus,
      diagnostics: {
        profileSource: companyResult.source,
        peersSource,
        profileHttpStatus: companyResult.httpStatus,
        peersHttpStatus,
        profileBodyState: companyResult.bodyState,
        peersBodyState: peersResult?.bodyState ?? (peers.length > 0 ? "ready" : "unknown"),
        profileTimedOut: companyResult.timedOut,
        peersTimedOut: peersResult?.timedOut ?? false,
        observedEndpoints: Array.from(new Set([
          ...companyResult.observedEndpoints,
          ...(peersResult?.observedEndpoints ?? []),
        ])),
        blockedEndpoints: Array.from(new Set([
          ...companyResult.blockedEndpoints,
          ...(peersResult?.blockedEndpoints ?? []),
        ])),
        providerWarning: launched.providerWarning,
      },
    };
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

const liveLookupPromises = new Map<string, Promise<PerplexityFinanceResponsePayload>>();

function getLiveLookup(ticker: string): Promise<PerplexityFinanceResponsePayload> {
  const existing = liveLookupPromises.get(ticker);
  if (existing) return existing;
  const promise = runLiveLookup(ticker).finally(() => liveLookupPromises.delete(ticker));
  liveLookupPromises.set(ticker, promise);
  return promise;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ticker = normalizeTicker(url.searchParams.get("ticker"));
  const refresh = url.searchParams.get("refresh") === "1";
  if (!ticker) {
    return NextResponse.json(
      { error: "Provide a valid ticker using letters, numbers, dot, or hyphen." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { peersUrl, profileUrl } = buildPerplexityUrls(ticker);
  const providerDecision = selectPerplexityBrowserProvider();
  const cached = await loadCachedLookup(ticker);
  if (!refresh && cached?.hit) {
    return NextResponse.json(withCache(cached.lookup, {
      mode: "hit",
      storedAt: cached.storedAt,
      ageSeconds: cached.ageSeconds,
    }), {
      headers: { "Cache-Control": cacheControlFor() },
    });
  }

  try {
    const live = await getLiveLookup(ticker);
    await storeCachedLookup(ticker, live).catch((error) => {
      console.warn("Perplexity Finance cache upsert failed", error);
    });
    return NextResponse.json(withCache(live, {
      mode: refresh ? "refresh" : "miss",
      storedAt: null,
      ageSeconds: null,
    }), {
      headers: { "Cache-Control": cacheControlFor() },
    });
  } catch (error) {
    if (refresh && cached?.hit) {
      return NextResponse.json(withCache({
        ...cached.lookup,
        warning: appendWarning(cached.lookup.warning, `Live refresh failed: ${errorMessage(error)}`),
      }, {
        mode: "stale_on_error",
        storedAt: cached.storedAt,
        ageSeconds: cached.ageSeconds ?? ageSeconds(cached.storedAt),
      }), {
        headers: { "Cache-Control": cacheControlFor() },
      });
    }
    const fetchedAt = new Date().toISOString();
    return NextResponse.json({
      ticker,
      fetchedAt,
      source: "perplexity_finance_dashboard",
      provider: providerDecision.provider,
      browserbaseConfigured: browserbaseConfigured(),
      peersUrl,
      profileUrl,
      company: emptyCompany(),
      peers: [],
      warning: errorMessage(error),
      status: "parse_error",
      profileStatus: "parse_error",
      peersStatus: "parse_error",
      diagnostics: {
        profileSource: null,
        peersSource: null,
        profileHttpStatus: null,
        peersHttpStatus: null,
        profileBodyState: "unknown",
        peersBodyState: "unknown",
        profileTimedOut: false,
        peersTimedOut: false,
        observedEndpoints: [],
        blockedEndpoints: [],
        providerWarning: providerDecision.reason,
      },
      cache: {
        mode: refresh ? "refresh" : "miss",
        storedAt: null,
        ageSeconds: null,
      },
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  }
}
