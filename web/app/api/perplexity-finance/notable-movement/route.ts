import { NextResponse } from "next/server";
import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  launchPerplexityBrowser,
  selectPerplexityBrowserProvider,
  type PerplexityBrowserProvider,
} from "@/lib/perplexity-browser-provider";
import {
  analyzePerplexityBodyText,
  normalizeTicker,
  parseNotablePriceMovementFromText,
  type PerplexityFinanceBodyState,
  type PerplexityNotablePriceMovementParseResult,
} from "@/lib/perplexity-finance-parser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

const DEFAULT_TIMEOUT_MS = 24_000;

type NotableMovementStatus = "ready" | "blocked" | "not_found" | "parse_error" | "pending_timeout";

type NotableMovementPayload = {
  ticker: string;
  fetchedAt: string;
  source: "perplexity_finance_page";
  url: string;
  notablePriceMovement: string | null;
  status: NotableMovementStatus;
  warning: string | null;
  diagnostics: {
    provider: PerplexityBrowserProvider;
    bodyState: PerplexityFinanceBodyState;
    matchedSelector: string | null;
    observedHeadings: string[];
  };
};

type WaitForMovementResult = PerplexityNotablePriceMovementParseResult & {
  bodyState: PerplexityFinanceBodyState;
  timedOut: boolean;
};

function buildPerplexityFinanceUrl(ticker: string): string {
  return `https://www.perplexity.ai/finance/${encodeURIComponent(ticker)}`;
}

function timeoutMs(): number {
  const parsed = Number(process.env.PERPLEXITY_FINANCE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(parsed) ? Math.max(8_000, Math.min(35_000, parsed)) : DEFAULT_TIMEOUT_MS;
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

async function waitForNotableMovement(page: Page, timeout: number): Promise<WaitForMovementResult> {
  const deadline = Date.now() + timeout;
  let bodyState: PerplexityFinanceBodyState = "unknown";
  let parsed: PerplexityNotablePriceMovementParseResult = {
    notablePriceMovement: null,
    matchedSelector: null,
    observedHeadings: [],
  };

  while (Date.now() < deadline) {
    const bodyText = await readBodyText(page);
    bodyState = analyzePerplexityBodyText(bodyText);
    parsed = parseNotablePriceMovementFromText(bodyText);
    if (bodyState === "blocked" || bodyState === "not_found" || parsed.notablePriceMovement) {
      return { ...parsed, bodyState, timedOut: false };
    }
    await page.waitForTimeout(500);
  }

  const bodyText = await readBodyText(page);
  bodyState = analyzePerplexityBodyText(bodyText);
  parsed = parseNotablePriceMovementFromText(bodyText);
  return { ...parsed, bodyState, timedOut: true };
}

function statusFor(wait: WaitForMovementResult): NotableMovementStatus {
  if (wait.notablePriceMovement) return "ready";
  if (wait.bodyState === "blocked") return "blocked";
  if (wait.bodyState === "not_found") return "not_found";
  if (wait.timedOut && (wait.bodyState === "pending" || wait.bodyState === "empty" || wait.bodyState === "unknown")) {
    return "pending_timeout";
  }
  if (wait.bodyState === "ready") return "not_found";
  if (wait.timedOut) return "pending_timeout";
  return "parse_error";
}

function combineWarnings(...warnings: Array<string | null | undefined>): string | null {
  const pieces = warnings
    .flatMap((warning) => warning ? warning.split(/(?<=\.)\s+/) : [])
    .map((warning) => warning.trim())
    .filter(Boolean);
  const uniqueWarnings = Array.from(new Set(pieces));
  return uniqueWarnings.length > 0 ? uniqueWarnings.join(" ") : null;
}

function warningFor(status: NotableMovementStatus, provider: PerplexityBrowserProvider): string | null {
  if (status === "blocked") {
    return provider === "browserbase"
      ? "Perplexity blocked the browser session before the visible finance page text could be read. Open a Browserbase verification session, complete any Perplexity check, then try again."
      : "Perplexity blocked the local browser session before the visible finance page text could be read.";
  }
  if (status === "pending_timeout") {
    return "Perplexity was still rendering the finance page when the lookup timed out. Try Refresh.";
  }
  if (status === "not_found") {
    return "Perplexity Finance did not expose a visible Notable Price Movement section for this ticker.";
  }
  if (status === "parse_error") {
    return "Perplexity Finance rendered, but the visible Notable Price Movement paragraph could not be parsed.";
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Perplexity Finance notable movement extraction failed.";
}

async function runLiveLookup(ticker: string): Promise<NotableMovementPayload> {
  const url = buildPerplexityFinanceUrl(ticker);
  const fetchedAt = new Date().toISOString();
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    const launched = await launchPerplexityBrowser();
    browser = launched.browser;
    context = launched.context;
    page = await context.newPage();

    const timeout = timeoutMs();
    await gotoAndPrime(page, url, timeout);
    const wait = await waitForNotableMovement(page, timeout);
    const status = statusFor(wait);

    return {
      ticker,
      fetchedAt,
      source: "perplexity_finance_page",
      url,
      notablePriceMovement: wait.notablePriceMovement,
      status,
      warning: combineWarnings(launched.providerWarning, warningFor(status, launched.provider)),
      diagnostics: {
        provider: launched.provider,
        bodyState: wait.bodyState,
        matchedSelector: wait.matchedSelector,
        observedHeadings: wait.observedHeadings,
      },
    };
  } finally {
    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

const liveLookupPromises = new Map<string, Promise<NotableMovementPayload>>();

function getLiveLookup(ticker: string): Promise<NotableMovementPayload> {
  const existing = liveLookupPromises.get(ticker);
  if (existing) return existing;
  const promise = runLiveLookup(ticker).finally(() => liveLookupPromises.delete(ticker));
  liveLookupPromises.set(ticker, promise);
  return promise;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ticker = normalizeTicker(url.searchParams.get("ticker"));
  if (!ticker) {
    return NextResponse.json(
      { error: "Provide a valid ticker using letters, numbers, dot, or hyphen." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    return NextResponse.json(await getLiveLookup(ticker), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const providerDecision = selectPerplexityBrowserProvider();
    return NextResponse.json({
      ticker,
      fetchedAt: new Date().toISOString(),
      source: "perplexity_finance_page",
      url: buildPerplexityFinanceUrl(ticker),
      notablePriceMovement: null,
      status: "parse_error",
      warning: combineWarnings(providerDecision.reason, errorMessage(error)),
      diagnostics: {
        provider: providerDecision.provider,
        bodyState: "unknown",
        matchedSelector: null,
        observedHeadings: [],
      },
    } satisfies NotableMovementPayload, {
      headers: { "Cache-Control": "no-store" },
    });
  }
}
