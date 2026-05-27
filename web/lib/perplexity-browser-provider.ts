import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";

export type PerplexityBrowserProvider = "browserbase" | "local_chromium";

type BrowserbaseRegion = "us-west-2" | "us-east-1" | "eu-central-1" | "ap-southeast-1";

type BrowserbaseConfig = {
  apiKey: string;
  projectId: string;
  contextId: string;
  region: BrowserbaseRegion;
  proxyEnabled: boolean;
  solveCaptchas: boolean;
  verified: boolean;
  sessionTimeoutSeconds: number;
  verificationTimeoutSeconds: number;
};

export type BrowserProviderDecision = {
  provider: PerplexityBrowserProvider;
  browserbaseConfigured: boolean;
  missingBrowserbaseEnv: string[];
  reason: string | null;
};

export type LaunchedPerplexityBrowser = {
  browser: Browser;
  context: BrowserContext;
  provider: PerplexityBrowserProvider;
  browserbaseConfigured: boolean;
  browserbaseSessionId?: string;
  browserbaseSessionUrl?: string;
  providerWarning: string | null;
};

export type BrowserbaseVerificationSession = {
  sessionId: string;
  expiresAt: string;
  debuggerUrl: string;
  debuggerFullscreenUrl: string;
  pages: Array<{
    id: string;
    debuggerUrl: string;
    debuggerFullscreenUrl: string;
    title: string;
    url: string;
  }>;
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BROWSERBASE_REQUIRED_ENV = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "BROWSERBASE_CONTEXT_ID"] as const;
const BROWSERBASE_REGIONS: BrowserbaseRegion[] = ["us-west-2", "us-east-1", "eu-central-1", "ap-southeast-1"];

function cleanEnv(value: string | undefined): string {
  return String(value ?? "").trim();
}

function envFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(cleanEnv(value));
}

function clampInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function browserbaseMissingEnv(env: NodeJS.ProcessEnv): string[] {
  return BROWSERBASE_REQUIRED_ENV.filter((key) => !cleanEnv(env[key]));
}

function browserbaseRegion(env: NodeJS.ProcessEnv): BrowserbaseRegion {
  const configured = cleanEnv(env.PERPLEXITY_BROWSERBASE_REGION);
  return BROWSERBASE_REGIONS.includes(configured as BrowserbaseRegion) ? configured as BrowserbaseRegion : "us-west-2";
}

function browserbaseConfig(env: NodeJS.ProcessEnv = process.env): BrowserbaseConfig | null {
  if (browserbaseMissingEnv(env).length > 0) return null;
  return {
    apiKey: cleanEnv(env.BROWSERBASE_API_KEY),
    projectId: cleanEnv(env.BROWSERBASE_PROJECT_ID),
    contextId: cleanEnv(env.BROWSERBASE_CONTEXT_ID),
    region: browserbaseRegion(env),
    proxyEnabled: envFlag(env.PERPLEXITY_BROWSERBASE_PROXY),
    solveCaptchas: envFlag(env.PERPLEXITY_BROWSERBASE_SOLVE_CAPTCHAS),
    verified: envFlag(env.PERPLEXITY_BROWSERBASE_VERIFIED),
    sessionTimeoutSeconds: clampInteger(env.PERPLEXITY_BROWSERBASE_SESSION_TIMEOUT_SECONDS, 120, 60, 900),
    verificationTimeoutSeconds: clampInteger(env.PERPLEXITY_BROWSERBASE_VERIFY_TIMEOUT_SECONDS, 900, 120, 900),
  };
}

export function selectPerplexityBrowserProvider(env: NodeJS.ProcessEnv = process.env): BrowserProviderDecision {
  const desiredProvider = cleanEnv(env.PERPLEXITY_BROWSER_PROVIDER).toLowerCase();
  const missingBrowserbaseEnv = browserbaseMissingEnv(env);
  const browserbaseConfigured = missingBrowserbaseEnv.length === 0;

  if (desiredProvider === "local_chromium") {
    return {
      provider: "local_chromium",
      browserbaseConfigured,
      missingBrowserbaseEnv,
      reason: "PERPLEXITY_BROWSER_PROVIDER is set to local_chromium.",
    };
  }

  if (desiredProvider === "browserbase" && !browserbaseConfigured) {
    return {
      provider: "local_chromium",
      browserbaseConfigured,
      missingBrowserbaseEnv,
      reason: `PERPLEXITY_BROWSER_PROVIDER is browserbase, but ${missingBrowserbaseEnv.join(", ")} is missing.`,
    };
  }

  if (browserbaseConfigured) {
    return {
      provider: "browserbase",
      browserbaseConfigured,
      missingBrowserbaseEnv,
      reason: null,
    };
  }

  return {
    provider: "local_chromium",
    browserbaseConfigured,
    missingBrowserbaseEnv,
    reason: null,
  };
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

async function launchLocalChromium(browserbaseConfigured: boolean, providerWarning: string | null): Promise<LaunchedPerplexityBrowser> {
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
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  return {
    browser,
    context,
    provider: "local_chromium",
    browserbaseConfigured,
    providerWarning,
  };
}

function browserbaseSessionPayload(config: BrowserbaseConfig, timeout: number, keepAlive: boolean) {
  return {
    projectId: config.projectId,
    region: config.region,
    timeout,
    keepAlive,
    proxies: config.proxyEnabled ? [{
      type: "browserbase" as const,
      geolocation: { country: "US" },
    }] : undefined,
    browserSettings: {
      context: {
        id: config.contextId,
        persist: true,
      },
      viewport: { width: 1280, height: 900 },
      blockAds: true,
      logSession: true,
      recordSession: true,
      os: "windows" as const,
      solveCaptchas: config.solveCaptchas || undefined,
      verified: config.verified || undefined,
    },
    userMetadata: {
      app: "market-overview",
      feature: "perplexity-finance-peer-lookup",
    },
  };
}

async function browserbaseClient(config: BrowserbaseConfig) {
  const mod = await import("@browserbasehq/sdk");
  const Browserbase = mod.default;
  return new Browserbase({ apiKey: config.apiKey });
}

async function launchBrowserbase(config: BrowserbaseConfig): Promise<LaunchedPerplexityBrowser> {
  const [{ chromium }, bb] = await Promise.all([
    import("playwright-core"),
    browserbaseClient(config),
  ]);
  const session = await bb.sessions.create(browserbaseSessionPayload(config, config.sessionTimeoutSeconds, false));
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0] ?? await browser.newContext();
  await context.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" }).catch(() => undefined);

  return {
    browser,
    context,
    provider: "browserbase",
    browserbaseConfigured: true,
    browserbaseSessionId: session.id,
    browserbaseSessionUrl: `https://www.browserbase.com/sessions/${session.id}`,
    providerWarning: null,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error ?? "Unknown error");
}

export async function launchPerplexityBrowser(): Promise<LaunchedPerplexityBrowser> {
  const decision = selectPerplexityBrowserProvider();
  const providerWarning = decision.reason;
  if (decision.provider !== "browserbase") {
    return launchLocalChromium(decision.browserbaseConfigured, providerWarning);
  }

  const config = browserbaseConfig();
  if (!config) {
    return launchLocalChromium(decision.browserbaseConfigured, providerWarning);
  }

  try {
    return await launchBrowserbase(config);
  } catch (error) {
    return launchLocalChromium(
      true,
      `Browserbase session creation failed (${errorMessage(error)}). Fell back to local Chromium.`,
    );
  }
}

export function browserbaseConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return browserbaseMissingEnv(env).length === 0;
}

export function browserbaseConfigurationError(env: NodeJS.ProcessEnv = process.env): string | null {
  const missing = browserbaseMissingEnv(env);
  return missing.length > 0 ? `Browserbase is missing ${missing.join(", ")}.` : null;
}

export async function createBrowserbaseVerificationSession(): Promise<BrowserbaseVerificationSession> {
  const config = browserbaseConfig();
  if (!config) {
    throw new Error(browserbaseConfigurationError() ?? "Browserbase is not configured.");
  }

  const bb = await browserbaseClient(config);
  const session = await bb.sessions.create(browserbaseSessionPayload(config, config.verificationTimeoutSeconds, true));
  const liveUrls = await bb.sessions.debug(session.id);

  return {
    sessionId: session.id,
    expiresAt: session.expiresAt,
    debuggerUrl: liveUrls.debuggerUrl,
    debuggerFullscreenUrl: liveUrls.debuggerFullscreenUrl,
    pages: liveUrls.pages.map((page) => ({
      id: page.id,
      debuggerUrl: page.debuggerUrl,
      debuggerFullscreenUrl: page.debuggerFullscreenUrl,
      title: page.title,
      url: page.url,
    })),
  };
}
