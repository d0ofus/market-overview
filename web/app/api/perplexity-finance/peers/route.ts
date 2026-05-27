import { existsSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import type { Browser, BrowserContext, Page } from "playwright-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CACHE_CONTROL = "public, s-maxage=21600, stale-while-revalidate=86400";
const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TICKER_PATTERN = /^[A-Z0-9]{1,8}(?:[.-][A-Z0-9]{1,4})?$/;

type PerplexityFinanceCompany = {
  name: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  description: string | null;
};

type PerplexityFinancePeer = {
  ticker: string;
  name: string | null;
  exchange: string | null;
  rawText: string;
};

type BrowserPeerRow = PerplexityFinancePeer & { score?: number };

function normalizeTicker(value: string | null): string | null {
  const ticker = String(value ?? "").trim().toUpperCase();
  if (!TICKER_PATTERN.test(ticker)) return null;
  return ticker;
}

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
  return Number.isFinite(parsed) ? Math.max(5_000, Math.min(30_000, parsed)) : DEFAULT_TIMEOUT_MS;
}

function localChromiumCandidates(): string[] {
  const candidates = [
    process.env.PERPLEXITY_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_EXECUTABLE_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  ];

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env["PROGRAMFILES(X86)"];
    candidates.push(
      localAppData ? join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : undefined,
      programFiles ? join(programFiles, "Google", "Chrome", "Application", "chrome.exe") : undefined,
      programFilesX86 ? join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe") : undefined,
      programFiles ? join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
      programFilesX86 ? join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
    );
  }

  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

async function loadServerlessChromium(): Promise<{
  args: string[];
  defaultViewport: { width: number; height: number };
  executablePath: () => Promise<string>;
} | null> {
  try {
    const mod = await import("@sparticuz/chromium");
    const chromium = (mod.default ?? mod) as {
      args: string[];
      defaultViewport: { width: number; height: number };
      executablePath: () => Promise<string>;
    };
    return chromium;
  } catch {
    return null;
  }
}

async function resolveChromiumExecutablePath(serverlessChromium: Awaited<ReturnType<typeof loadServerlessChromium>>): Promise<string | null> {
  const localCandidate = localChromiumCandidates().find((candidate) => existsSync(candidate));
  if (localCandidate) return localCandidate;

  if (!serverlessChromium) return null;
  try {
    return await serverlessChromium.executablePath();
  } catch {
    return null;
  }
}

async function launchBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
  const [{ chromium }, serverlessChromium] = await Promise.all([
    import("playwright-core"),
    loadServerlessChromium(),
  ]);
  const executablePath = await resolveChromiumExecutablePath(serverlessChromium);
  if (!executablePath) {
    throw new Error("No Chromium executable was available for Perplexity Finance extraction.");
  }

  const args = Array.from(new Set([
    ...(serverlessChromium?.args ?? []),
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--disable-setuid-sandbox",
    "--no-sandbox",
  ]));
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args,
  });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: serverlessChromium?.defaultViewport ?? { width: 1280, height: 900 },
    locale: "en-US",
  });
  return { browser, context };
}

async function gotoAndSettle(page: Page, url: string): Promise<void> {
  const timeout = timeoutMs();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await page.getByText("Necessary only", { exact: true }).click({ timeout: 2_000 }).catch(() => undefined);
  await page.getByText("Allow all", { exact: true }).click({ timeout: 1_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: Math.min(7_500, timeout) }).catch(() => undefined);
  await page.waitForFunction(() => Boolean(document.body?.innerText?.trim()), undefined, {
    timeout: Math.min(5_000, timeout),
  }).catch(() => undefined);
  await page.waitForTimeout(1_200);
}

async function extractCompany(context: BrowserContext, ticker: string, profileUrl: string): Promise<PerplexityFinanceCompany> {
  const page = await context.newPage();
  try {
    await gotoAndSettle(page, profileUrl);
    return await page.evaluate((inputTicker) => {
      const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
      const lineClean = (value: unknown) => String(value ?? "").replace(/\u00a0/g, " ").trim();
      const rawBodyText = document.body?.innerText ?? "";
      if (/Performing security verification|security service to protect|Checking your browser/i.test(rawBodyText)) {
        return {
          name: null,
          exchange: null,
          sector: null,
          industry: null,
          description: null,
        };
      }
      const lines = rawBodyText.split(/\n+/).map(lineClean).filter(Boolean);
      const tickerUpper = inputTicker.toUpperCase();
      const tickerPattern = /^[A-Z0-9]{1,8}(?:[.-][A-Z0-9]{1,4})?$/;
      const allElementTexts = Array.from(document.querySelectorAll("tr, li, div, section, article, p"))
        .map((node) => clean((node as HTMLElement).innerText))
        .filter(Boolean);

      const valueAfterLine = (label: string): string | null => {
        const target = label.toLowerCase();
        const lineIndex = lines.findIndex((line) => line.toLowerCase() === target);
        return lineIndex >= 0 ? lines[lineIndex + 1] ?? null : null;
      };

      const valueFromElement = (label: string): string | null => {
        const target = label.toLowerCase();
        for (const text of allElementTexts) {
          const compact = clean(text);
          const lower = compact.toLowerCase();
          if (lower === target) continue;
          if (lower.startsWith(`${target} `)) {
            const value = compact.slice(label.length).trim();
            if (value) return value;
          }
          const rowLines = text.split(/\n+/).map(lineClean).filter(Boolean);
          const labelIndex = rowLines.findIndex((line) => line.toLowerCase() === target);
          if (labelIndex >= 0 && rowLines[labelIndex + 1]) return rowLines[labelIndex + 1];
        }
        return valueAfterLine(label);
      };

      const heading = Array.from(document.querySelectorAll("h1, [role='heading']"))
        .map((node) => clean((node as HTMLElement).innerText))
        .find((text) => text && text.toUpperCase() !== tickerUpper && !tickerPattern.test(text.toUpperCase())) ?? null;

      const descriptionCandidates = Array.from(document.querySelectorAll("p, article, section, div"))
        .map((node) => clean((node as HTMLElement).innerText))
        .filter((text, index, arr) => {
          if (text.length < 120 || text.length > 2_800) return false;
          if (arr.indexOf(text) !== index) return false;
          if (/Overview\s+Financials\s+Earnings/i.test(text)) return false;
          if (/Ask anything about/i.test(text)) return false;
          if (/Prev Close|Market Cap|Day Range|Dividend Yield/i.test(text) && text.length > 600) return false;
          return /\b(is|are|was|operates|develops|provides|offers|manufactures|sells|focuses)\b/i.test(text);
        })
        .map((text) => {
          let score = 0;
          if (heading && text.toLowerCase().includes(heading.toLowerCase())) score += 4;
          if (text.toUpperCase().includes(tickerUpper)) score += 2;
          if (/\bis an?\b|\bis a\b/i.test(text)) score += 2;
          if (text.length >= 180 && text.length <= 1_800) score += 1;
          if (/Notable Price Movement|After-hours|At close/i.test(text)) score -= 3;
          return { text, score };
        })
        .sort((left, right) => right.score - left.score || right.text.length - left.text.length);

      let description = descriptionCandidates[0]?.text ?? null;
      if (description && heading) {
        const headingIndex = description.toLowerCase().indexOf(heading.toLowerCase());
        if (headingIndex > 0) description = description.slice(headingIndex).trim();
      }
      if (description) description = description.replace(/\s*View More\s*$/i, "").trim();

      return {
        name: heading,
        exchange: valueFromElement("Exchange"),
        sector: valueFromElement("Sector"),
        industry: valueFromElement("Industry"),
        description,
      };
    }, ticker);
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function extractPeers(context: BrowserContext, ticker: string, peersUrl: string): Promise<PerplexityFinancePeer[]> {
  const page = await context.newPage();
  try {
    await gotoAndSettle(page, peersUrl);
    const rows = await page.evaluate((rootTicker): BrowserPeerRow[] => {
      const bodyText = document.body?.innerText ?? "";
      if (/Performing security verification|security service to protect|Checking your browser/i.test(bodyText)) return [];
      const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
      const lineClean = (value: unknown) => String(value ?? "").replace(/\u00a0/g, " ").trim();
      const tickerPattern = /^[A-Z0-9]{1,8}(?:[.-][A-Z0-9]{1,4})?$/;
      const exchangePattern = /\b(NASDAQ|NYSE|AMEX|ARCA|BATS|IEX|OTC|TSX|ASX|LSE|HKEX)\b/i;

      const isVisible = (element: Element | null): boolean => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
        if (String(element.className).includes("invisible")) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const parseName = (rawText: string, ticker: string, anchorText: string): string | null => {
        const anchor = clean(anchorText).replace(new RegExp(`\\s+${ticker}$`, "i"), "").trim();
        if (anchor && anchor.toUpperCase() !== ticker && !tickerPattern.test(anchor.toUpperCase())) return anchor;
        const lines = rawText.split(/\n+/).map(lineClean).filter(Boolean);
        const tickerIndex = lines.findIndex((line) => {
          const upper = line.toUpperCase();
          return upper === ticker || upper.startsWith(`${ticker} `) || upper.endsWith(` ${ticker}`);
        });
        const candidates = [
          tickerIndex > 0 ? lines[tickerIndex - 1] : null,
          tickerIndex >= 0 ? lines[tickerIndex + 1] : null,
          ...lines,
        ]
          .map((line) => clean(line))
          .filter((line): line is string => {
            if (!line || line.toUpperCase() === ticker) return false;
            if (tickerPattern.test(line.toUpperCase())) return false;
            if (exchangePattern.test(line) && line.length <= 24) return false;
            if (/^\$|%$|Market Cap|Price|Follow|Compare|Change/i.test(line)) return false;
            return line.length >= 3 && line.length <= 100;
          });
        return candidates[0] ?? null;
      };

      const parseExchange = (rawText: string): string | null => {
        const lines = rawText.split(/\n+/).map(lineClean).filter(Boolean);
        const direct = lines.find((line) => exchangePattern.test(line) && line.length <= 50);
        if (direct) return direct;
        const match = rawText.match(exchangePattern);
        return match?.[0]?.toUpperCase() ?? null;
      };

      const isSidebarWidgetLink = (anchor: HTMLAnchorElement): boolean => {
        let node: HTMLElement | null = anchor;
        for (let depth = 0; node && depth < 7; depth += 1) {
          const text = clean(node.innerText);
          if (/Create Watchlist|Equity Sectors|Popular Cryptocurrencies|Fixed Income/i.test(text)) return true;
          node = node.parentElement;
        }
        return false;
      };

      const closestReadableInfo = (anchor: HTMLAnchorElement, ticker: string): { rawText: string; score: number } => {
        const row = anchor.closest("tr") ?? anchor.closest("[role='row']");
        if (row instanceof HTMLElement && isVisible(row)) {
          const rowText = clean(row.innerText);
          if (rowText.toUpperCase().includes(ticker) && rowText.length <= 900) {
            return { rawText: rowText || ticker, score: 1_000 - Math.min(rowText.length, 500) };
          }
        }

        let node: HTMLElement | null =
          anchor.closest("li") ??
          anchor.closest("p") ??
          anchor.parentElement;
        let fallback = clean(anchor.innerText);
        let score = 0;
        for (let depth = 0; node && depth < 6; depth += 1) {
          if (!isVisible(node)) {
            node = node.parentElement;
            continue;
          }
          const text = clean(node.innerText);
          if (text.toUpperCase().includes(ticker) && text.length >= ticker.length && text.length <= 900) {
            fallback = text;
            score = node.tagName === "P" ? 100 - depth : 20 - depth;
            if (text.length > ticker.length + 3) break;
          }
          node = node.parentElement;
        }
        return { rawText: fallback || ticker, score };
      };

      const found = new Map<string, BrowserPeerRow>();
      const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='/finance/']")).filter(isVisible);
      for (const anchor of anchors) {
        if (isSidebarWidgetLink(anchor)) continue;
        let symbol: string | null = null;
        try {
          const url = new URL(anchor.href);
          const match = url.pathname.match(/^\/finance\/([^/?#]+)$/i);
          symbol = match ? decodeURIComponent(match[1]).toUpperCase() : null;
        } catch {
          symbol = null;
        }
        if (!symbol || symbol === rootTicker || !tickerPattern.test(symbol)) continue;
        const { rawText, score } = closestReadableInfo(anchor, symbol);
        if (/Create Watchlist|Equity Sectors|Popular Cryptocurrencies|Fixed Income/i.test(rawText)) continue;
        const name = parseName(rawText, symbol, anchor.innerText);
        const exchange = parseExchange(rawText);
        const previous = found.get(symbol);
        if (!previous || score > (previous.score ?? 0)) {
          found.set(symbol, { ticker: symbol, name, exchange, rawText, score });
        }
      }

      return Array.from(found.values()).slice(0, 50);
    }, ticker);

    return rows.map(({ score: _score, ...row }) => row);
  } finally {
    await page.close().catch(() => undefined);
  }
}

function warningFor(company: PerplexityFinanceCompany, peers: PerplexityFinancePeer[]): string | null {
  const warnings: string[] = [];
  if (!company.description) warnings.push("Company description was not parseable from the Perplexity profile page.");
  if (peers.length === 0) warnings.push("No peer rows were parseable from the Perplexity Finance peers dashboard.");
  return warnings.length > 0 ? warnings.join(" ") : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Perplexity Finance extraction failed.";
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

  const { peersUrl, profileUrl } = buildPerplexityUrls(ticker);
  const fetchedAt = new Date().toISOString();
  let browser: Browser | null = null;
  try {
    const launched = await launchBrowser();
    browser = launched.browser;
    const [company, peers] = await Promise.all([
      extractCompany(launched.context, ticker, profileUrl),
      extractPeers(launched.context, ticker, peersUrl),
    ]);
    await launched.context.close().catch(() => undefined);

    return NextResponse.json({
      ticker,
      fetchedAt,
      source: "perplexity_finance_dashboard",
      peersUrl,
      profileUrl,
      company,
      peers,
      warning: warningFor(company, peers),
    }, {
      headers: { "Cache-Control": CACHE_CONTROL },
    });
  } catch (error) {
    return NextResponse.json({
      ticker,
      fetchedAt,
      source: "perplexity_finance_dashboard",
      peersUrl,
      profileUrl,
      company: {
        name: null,
        exchange: null,
        sector: null,
        industry: null,
        description: null,
      },
      peers: [],
      warning: errorMessage(error),
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
