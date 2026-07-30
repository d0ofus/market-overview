import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractReadableTextFromHtml,
  loadLatestFomcCommentary,
  normalizeBraveFomcSources,
  normalizeFomcCommentaryRow,
  parseGeminiFomcJson,
  refreshFomcCommentary,
  shouldGenerateFomcSummary,
  shouldRunScheduledFomcRefresh,
  testExports,
  type FomcCommentaryEventType,
  type FomcCommentarySourceMode,
  type FomcCommentaryStatus,
} from "../src/fomc-commentary-service";
import type { Env } from "../src/types";

const row = {
  id: "item-1",
  eventType: "minutes" as const,
  meetingDate: "2026-06-17",
  releaseDate: "2026-07-08",
  sourceUrl: "https://www.federalreserve.gov/monetarypolicy/fomcminutes20260617.htm",
  sourceTitle: "Minutes",
  statementUrl: null,
  rateDecision: "Held at 3.50%–3.75%",
  sourceMode: "official_plus_brave" as const,
  status: "ready" as const,
  summaryMarkdown: "## Policy signal",
  highlightsJson: JSON.stringify(["Rates steady", "Inflation still elevated"]),
  tradingReadThrough: "Watch the curve.",
  citationSourcesJson: JSON.stringify([
    { sourceName: "Reuters", url: "https://www.reuters.com/markets/us/fomc", title: "FOMC", snippet: "Markets", usedFor: "context" },
  ]),
  generatedAt: "2026-07-08T18:00:00.000Z",
  provider: "gemini",
  model: "gemini-test",
  error: null,
  sourceFetchedAt: "2026-07-08T18:00:00.000Z",
  sourceTextHash: "abc123",
  lastCheckedAt: "2026-07-08T18:05:00.000Z",
  lastUnchangedAt: null,
  lastRefreshAttemptAt: "2026-07-08T18:00:00.000Z",
  refreshAttemptCount: 1,
};

const OFFICIAL_URL = "https://www.federalreserve.gov/monetarypolicy/fomcminutes20260617.htm";
const PRESS_CONFERENCE_URL = "https://www.federalreserve.gov/monetarypolicy/fomcpresconf20260729.htm";
const STATEMENT_URL = "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm";
const JULY_STATEMENT = [
  "The Federal Open Market Committee approved the following statement for release by a 9 – 3 vote.",
  "The Committee decided to maintain the target range for the federal funds rate at 3-1/2 to 3-3/4 percent, in support of the Federal Reserve's dual mandate.",
  "Economic activity is expanding at a solid pace. Job gains have kept pace with the workforce, and the unemployment rate has changed little.",
  "Inflation remains elevated relative to the Committee's 2 percent goal.",
  "Voting against the monetary policy action were three members, who preferred to raise the target range for the federal funds rate by 1/4 percentage point at this meeting.",
].join(" ");
const LONG_OFFICIAL_TEXT = Array.from({ length: 60 }, () => (
  "The Committee decided to maintain the target range for the federal funds rate. Inflation remains somewhat elevated and labor market conditions remained solid. The economic outlook is uncertain and the Committee remains attentive to risks."
)).join(" ");

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type FakeFomcStoredRow = {
  id: string;
  eventType: FomcCommentaryEventType;
  meetingDate: string;
  releaseDate: string | null;
  sourceUrl: string;
  sourceTitle: string | null;
  statementUrl: string | null;
  rateDecision: string | null;
  sourceText: string | null;
  sourceMode: FomcCommentarySourceMode;
  braveSourcesJson: string | null;
  citationSourcesJson: string | null;
  status: FomcCommentaryStatus;
  summaryMarkdown: string | null;
  highlightsJson: string | null;
  tradingReadThrough: string | null;
  generatedAt: string | null;
  provider: string | null;
  model: string | null;
  error: string | null;
  sourceFetchedAt: string | null;
  sourceTextHash: string | null;
  lastCheckedAt: string | null;
  lastUnchangedAt: string | null;
  lastRefreshAttemptAt: string | null;
  refreshAttemptCount: number;
  createdAt?: string;
  updatedAt?: string;
};

class FakeFomcDb {
  rows: FakeFomcStoredRow[];

  constructor(rows: FakeFomcStoredRow[] = []) {
    this.rows = rows;
  }

  prepare(sql: string) {
    const db = this;
    let bound: unknown[] = [];
    const normalized = sql.replace(/\s+/g, " ");
    const statement = {
      bind(...args: unknown[]) {
        bound = args;
        return statement;
      },
      async first<T>() {
        if (normalized.includes("FROM brave_search_cache")) return null as T;
        if (normalized.includes("FROM fomc_commentary_items") && normalized.includes("WHERE event_type = ? AND meeting_date = ? AND source_url = ?")) {
          return (db.rows.find((item) =>
            item.eventType === bound[0]
            && item.meetingDate === bound[1]
            && item.sourceUrl === bound[2]
          ) ?? null) as T;
        }
        return null as T;
      },
      async all<T>() {
        if (normalized.includes("SELECT event_type as eventType") && normalized.includes("FROM fomc_commentary_items")) {
          const localDate = String(bound[0]);
          const rows = db.rows.filter((item) => (
            item.meetingDate === localDate
            || item.releaseDate === localDate
            || (item.status === "pending_source" && String(item.lastCheckedAt ?? item.updatedAt ?? item.createdAt ?? "").slice(0, 10) === localDate)
          )).map((item) => ({ eventType: item.eventType }));
          return { results: rows as T[] };
        }
        if (normalized.includes("FROM fomc_commentary_items")) {
          return { results: [...db.rows] as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        if (normalized.startsWith("UPDATE fomc_commentary_items")) {
          const item = db.rows.find((candidate) => candidate.id === String(bound[3]));
          if (item) {
            item.lastCheckedAt = String(bound[0]);
            item.lastUnchangedAt = String(bound[1]);
            item.updatedAt = String(bound[2]);
          }
          return { meta: { rows_written: item ? 1 : 0 } };
        }
        if (normalized.startsWith("INSERT INTO fomc_commentary_items")) {
          const item: FakeFomcStoredRow = {
            id: String(bound[0]),
            eventType: bound[1] as FakeFomcStoredRow["eventType"],
            meetingDate: String(bound[2]),
            releaseDate: bound[3] == null ? null : String(bound[3]),
            sourceUrl: String(bound[4]),
            sourceTitle: bound[5] == null ? null : String(bound[5]),
            statementUrl: bound[6] == null ? null : String(bound[6]),
            rateDecision: bound[7] == null ? null : String(bound[7]),
            sourceText: bound[8] == null ? null : String(bound[8]),
            sourceFetchedAt: bound[9] == null ? null : String(bound[9]),
            sourceMode: bound[10] as FakeFomcStoredRow["sourceMode"],
            braveSourcesJson: String(bound[11]),
            citationSourcesJson: String(bound[12]),
            summaryMarkdown: bound[13] == null ? null : String(bound[13]),
            highlightsJson: String(bound[14]),
            tradingReadThrough: bound[15] == null ? null : String(bound[15]),
            provider: bound[16] == null ? null : String(bound[16]),
            model: bound[17] == null ? null : String(bound[17]),
            status: bound[18] as FakeFomcStoredRow["status"],
            error: bound[19] == null ? null : String(bound[19]),
            generatedAt: bound[20] == null ? null : String(bound[20]),
            sourceTextHash: bound[21] == null ? null : String(bound[21]),
            lastCheckedAt: bound[22] == null ? null : String(bound[22]),
            lastUnchangedAt: bound[23] == null ? null : String(bound[23]),
            lastRefreshAttemptAt: bound[24] == null ? null : String(bound[24]),
            refreshAttemptCount: Number(bound[25] ?? 0),
            createdAt: String(bound[26]),
            updatedAt: String(bound[27]),
          };
          const existingIndex = db.rows.findIndex((candidate) =>
            candidate.eventType === item.eventType
            && candidate.meetingDate === item.meetingDate
            && candidate.sourceUrl === item.sourceUrl
          );
          if (existingIndex >= 0) {
            db.rows[existingIndex] = { ...item, createdAt: db.rows[existingIndex].createdAt };
          } else {
            db.rows.push(item);
          }
          return { meta: { rows_written: 1 } };
        }
        return { meta: { rows_written: 0 } };
      },
    };
    return statement;
  }
}

function createFomcEnv(db: FakeFomcDb): Env {
  return {
    DB: db as unknown as D1Database,
    BRAVE_SEARCH_API_KEY: "brave-test-key",
    GEMINI_API_KEY: "gemini-test-key",
  } as Env;
}

function createReadyFomcRow(sourceTextHash: string): FakeFomcStoredRow {
  return {
    ...row,
    id: "existing-fomc",
    sourceUrl: OFFICIAL_URL,
    sourceMode: "official",
    sourceText: LONG_OFFICIAL_TEXT,
    braveSourcesJson: "[]",
    sourceTextHash,
  };
}

function stubFomcFetches(officialText = LONG_OFFICIAL_TEXT) {
  const counts = { official: 0, brave: 0, gemini: 0 };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.search.brave.com")) {
      counts.brave += 1;
      const query = new URL(url).searchParams.get("q") ?? "";
      const results = query.startsWith("site:federalreserve.gov")
        ? [{ title: "Official FOMC minutes", url: OFFICIAL_URL, description: "Fed minutes", profile: { name: "Federal Reserve" }, age: "2026-06-17" }]
        : [{ title: "Reuters FOMC take", url: "https://www.reuters.com/markets/us/fomc-minutes", description: "Markets parsed the minutes.", profile: { name: "Reuters" }, age: "2026-06-17" }];
      return new Response(JSON.stringify({
        web: {
          results,
        },
      }), { status: 200 });
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      counts.gemini += 1;
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                highlights: ["Rates path unchanged"],
                tradingReadThrough: "Curve repricing risk remains data dependent.",
                summaryMarkdown: "## Policy signal\nRates unchanged.",
                usedCitationUrls: ["https://www.reuters.com/markets/us/fomc-minutes"],
              }),
            }],
          },
          groundingMetadata: { groundingChunks: [] },
        }],
      }), { status: 200 });
    }
    if (url.includes("federalreserve.gov")) {
      counts.official += 1;
      return new Response(`<html><main>${officialText}</main></html>`, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }));
  return counts;
}

describe("FOMC commentary service helpers", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loadLatestFomcCommentary returns [] when the migration has not been applied", async () => {
    const env = {
      DB: {
        prepare() {
          return {
            bind() { return this; },
            async all() { throw new Error("no such table: fomc_commentary_items"); },
          };
        },
      },
    };
    await expect(loadLatestFomcCommentary(env as never)).resolves.toEqual([]);
  });

  it("normalizes stored rows and safely parses highlights and citations", () => {
    const item = normalizeFomcCommentaryRow(row);
    expect(item.highlights).toEqual(["Rates steady", "Inflation still elevated"]);
    expect(item.citationSources).toHaveLength(1);
    expect(item.sourceMode).toBe("official_plus_brave");
    expect(item.rateDecision).toBe("Held at 3.50%–3.75%");
    expect(item.statementUrl).toBeNull();
    expect(item.sourceTextHash).toBe("abc123");
    expect(item.lastCheckedAt).toBe("2026-07-08T18:05:00.000Z");
    expect(item.refreshAttemptCount).toBe(1);
  });

  it("falls back to empty arrays for malformed JSON", () => {
    const item = normalizeFomcCommentaryRow({ ...row, highlightsJson: "not json", citationSourcesJson: "{}" });
    expect(item.highlights).toEqual([]);
    expect(item.citationSources).toEqual([]);
  });

  it("extracts readable Fed-like HTML without script/style/nav noise", () => {
    const text = extractReadableTextFromHtml("<html><script>bad()</script><style>.x{}</style><nav>Menu</nav><main><h1>FOMC Minutes</h1><p>Policy stayed restrictive &amp; data-dependent.</p></main></html>");
    expect(text).toContain("FOMC Minutes");
    expect(text).toContain("Policy stayed restrictive & data-dependent.");
    expect(text).not.toContain("bad()");
    expect(text).not.toContain("Menu");
  });

  it("keeps only allowlisted Brave citations and marks Fed URLs as discovery", () => {
    const sources = normalizeBraveFomcSources([
      { title: "Fed minutes", url: "https://www.federalreserve.gov/monetarypolicy/fomcminutes.htm", description: "Official", source: null, publishedAt: null },
      { title: "Reuters take", url: "https://www.reuters.com/markets/us/fed-minutes", description: "Context", source: "Reuters", publishedAt: null },
      { title: "Random blog", url: "https://example.com/fed", description: "Nope", source: "Blog", publishedAt: null },
    ], "context");
    expect(sources.map((source) => source.sourceName)).toEqual(["Federal Reserve", "Reuters"]);
    expect(sources[0]?.usedFor).toBe("discovery");
    expect(sources[1]?.usedFor).toBe("context");
  });

  it("parses strict Gemini JSON and used citation URLs", () => {
    const parsed = parseGeminiFomcJson('```json\n{"highlights":["Rates path unchanged"],"tradingReadThrough":"Curve repricing risk.","summaryMarkdown":"## Policy signal","usedCitationUrls":["https://www.reuters.com/markets/us/fed-minutes"]}\n```');
    expect(parsed.highlights).toEqual(["Rates path unchanged"]);
    expect(parsed.usedCitationUrls).toEqual(["https://www.reuters.com/markets/us/fed-minutes"]);
  });

  it("builds a prompt that constrains Brave to cited context/fallback", () => {
    const prompt = testExports.buildFomcPrompt({
      eventType: "minutes",
      meetingDate: "2026-06-17",
      sourceMode: "fallback_context",
      officialText: "Reuters: officials sounded cautious.",
      citations: [{ sourceName: "Reuters", url: "https://www.reuters.com/markets/us/fed-minutes", title: "Fed", snippet: "Officials cautious", usedFor: "fallback" }],
    });
    expect(prompt).toContain("Primary source text is authoritative");
    expect(prompt).toContain("SECONDARY-SOURCE FALLBACK");
    expect(prompt).toContain("must be cited");
    expect(prompt).toContain("https://www.reuters.com/markets/us/fed-minutes");
  });

  it("finds the latest official press conference and minutes links from the Fed calendar", () => {
    const sources = testExports.extractOfficialFomcSourcesFromCalendar(`
      <a href="/monetarypolicy/fomcpresconf20260429.htm">Press Conference</a>
      <a href="/monetarypolicy/fomcminutes20260429.htm">HTML</a>
      <a href="/monetarypolicy/fomcpresconf20260617.htm">Future Press Conference</a>
      <a href="/monetarypolicy/fomcminutes20260617.htm">Future Minutes</a>
    `, new Date("2026-05-01T00:00:00.000Z"));
    expect(sources).toEqual([
      { eventType: "press_conference", meetingDate: "2026-04-29", sourceUrl: "https://www.federalreserve.gov/monetarypolicy/fomcpresconf20260429.htm" },
      { eventType: "minutes", meetingDate: "2026-04-29", sourceUrl: "https://www.federalreserve.gov/monetarypolicy/fomcminutes20260429.htm" },
    ]);
  });

  it("discovers the official statement and transcript links from a press conference landing page", () => {
    const links = testExports.extractOfficialFomcMaterialLinks(`
      <a href="/newsevents/pressreleases/monetary20260729a.htm">FOMC Meeting Statement</a>
      <a href="/mediacenter/files/FOMCpresconf20260729.pdf">Press Conference Transcript (PDF)</a>
    `, "2026-07-29");
    expect(links).toEqual({
      statementUrl: STATEMENT_URL,
      transcriptUrl: "https://www.federalreserve.gov/mediacenter/files/FOMCpresconf20260729.pdf",
    });
  });

  it.each([
    ["The Committee decided to maintain the target range for the federal funds rate at 3-1/2 to 3-3/4 percent.", "Held at 3.50%–3.75%"],
    ["The Committee decided to keep the target range for the federal funds rate at 4.25 to 4.50 percent.", "Held at 4.25%–4.50%"],
    ["The Committee decided to lower the target range for the federal funds rate by 1/4 percentage point to 4-1/4 to 4-1/2 percent.", "Cut 25 bp to 4.25%–4.50%"],
    ["The Committee decided to raise the target range for the federal funds rate by 1/2 percentage point to 5 to 5-1/4 percent.", "Hiked 50 bp to 5.00%–5.25%"],
  ])("parses an official rate decision: %s", (policySentence, expectedLabel) => {
    expect(testExports.parseFomcRateDecision(policySentence)?.label).toBe(expectedLabel);
  });

  it("does not guess a rate decision when the official sentence is malformed", () => {
    expect(testExports.parseFomcRateDecision("The Committee discussed the federal funds rate.")).toBeNull();
  });

  it("normalizes source text before hash comparison", () => {
    expect(testExports.normalizeSourceTextForHash("A\n\n  B\tC")).toBe("A B C");
  });

  it("requires the latest row of each FOMC event type to be ready", () => {
    const currentPress = normalizeFomcCommentaryRow({
      ...row,
      id: "current-press",
      eventType: "press_conference",
      meetingDate: "2026-07-29",
      releaseDate: "2026-07-29",
      status: "pending_source",
    });
    const olderPress = normalizeFomcCommentaryRow({
      ...row,
      id: "older-press",
      eventType: "press_conference",
      meetingDate: "2026-06-17",
      releaseDate: "2026-06-17",
      status: "ready",
    });
    const latestMinutes = normalizeFomcCommentaryRow({ ...row, id: "latest-minutes", status: "ready" });
    expect(testExports.hasReadyLatestFomcTypes([currentPress, latestMinutes, olderPress])).toBe(false);
    expect(testExports.hasReadyLatestFomcTypes([{ ...currentPress, status: "ready" }, latestMinutes, olderPress])).toBe(true);
  });

  it("skips Gemini for ready official summaries when source hash is unchanged", () => {
    expect(shouldGenerateFomcSummary({
      existingStatus: "ready",
      existingSourceTextHash: "hash-1",
      nextSourceTextHash: "hash-1",
      hasOfficialText: true,
      sourceMode: "official_plus_brave",
    })).toBe(false);
    expect(shouldGenerateFomcSummary({
      existingStatus: "ready",
      existingSourceTextHash: "hash-1",
      nextSourceTextHash: "hash-2",
      hasOfficialText: true,
      sourceMode: "official_plus_brave",
    })).toBe(true);
    expect(shouldGenerateFomcSummary({
      force: true,
      existingStatus: "ready",
      existingSourceTextHash: "hash-1",
      nextSourceTextHash: "hash-1",
      hasOfficialText: true,
      sourceMode: "official",
    })).toBe(true);
    expect(shouldGenerateFomcSummary({
      existingStatus: "failed",
      existingSourceTextHash: "hash-1",
      nextSourceTextHash: "hash-1",
      hasOfficialText: true,
      sourceMode: "official",
    })).toBe(true);
  });

  it("retries unchanged extractive fallbacks hourly, capped at three attempts per source hash", () => {
    const common = {
      existingStatus: "ready" as const,
      existingProvider: "extractive_fallback",
      existingSourceTextHash: "hash-1",
      nextSourceTextHash: "hash-1",
      hasOfficialText: true,
      sourceMode: "official" as const,
      now: new Date("2026-07-30T03:00:00.000Z"),
    };
    expect(shouldGenerateFomcSummary({
      ...common,
      existingLastRefreshAttemptAt: "2026-07-30T01:59:59.000Z",
      existingRefreshAttemptCount: 1,
    })).toBe(true);
    expect(shouldGenerateFomcSummary({
      ...common,
      existingLastRefreshAttemptAt: "2026-07-30T02:30:00.000Z",
      existingRefreshAttemptCount: 1,
    })).toBe(false);
    expect(shouldGenerateFomcSummary({
      ...common,
      existingLastRefreshAttemptAt: "2026-07-30T01:00:00.000Z",
      existingRefreshAttemptCount: 3,
    })).toBe(false);
  });

  it("can build an official-source extractive fallback when Gemini is unavailable", () => {
    const fallback = testExports.buildExtractiveFomcSummary({
      eventType: "press_conference",
      meetingDate: "2026-07-29",
      officialText: JULY_STATEMENT,
    });
    expect(fallback.highlights.length).toBeGreaterThan(0);
    expect(fallback.highlights.join(" ")).toContain("3-1/2 to 3-3/4 percent");
    expect(fallback.highlights.join(" ")).toContain("Voting against");
    expect(fallback.summaryMarkdown).toContain("Policy signal");
    expect(fallback.tradingReadThrough).toContain("Held at 3.50%–3.75%");
  });

  it("fetches the linked statement and keeps an informative fallback when Gemini returns 503", async () => {
    const db = new FakeFomcDb();
    const fetchedUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("api.search.brave.com")) {
        return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      if (url === PRESS_CONFERENCE_URL) {
        return new Response(`
          <html><title>July 28-29, 2026 FOMC Meeting</title><div id="content" role="main">
            ${"Video instructions and navigation. ".repeat(80)}
            <a href="/newsevents/pressreleases/monetary20260729a.htm">FOMC Meeting Statement</a>
            <a href="/mediacenter/files/FOMCpresconf20260729.pdf">Press Conference Transcript (PDF)</a>
          </div></html>
        `, { status: 200 });
      }
      if (url === STATEMENT_URL) {
        return new Response(`<html><title>Federal Reserve issues FOMC statement</title><div class="col-xs-12 col-sm-8 col-md-8"><p>${JULY_STATEMENT}</p></div></html>`, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));

    const result = await refreshFomcCommentary(createFomcEnv(db), {
      eventType: "press_conference",
      meetingDate: "2026-07-29",
      sourceUrl: PRESS_CONFERENCE_URL,
      now: new Date("2026-07-29T21:11:47.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(fetchedUrls).toContain(STATEMENT_URL);
    expect(db.rows[0]?.sourceUrl).toBe(PRESS_CONFERENCE_URL);
    expect(db.rows[0]?.statementUrl).toBe(STATEMENT_URL);
    expect(db.rows[0]?.rateDecision).toBe("Held at 3.50%–3.75%");
    expect(db.rows[0]?.provider).toBe("extractive_fallback");
    expect(db.rows[0]?.sourceMode).toBe("official");
    expect(db.rows[0]?.summaryMarkdown).toContain("Inflation remains elevated");
    expect(db.rows[0]?.error).toContain("HTTP 503");
  });

  it("does not classify a long press conference landing page as substantive official text", async () => {
    const db = new FakeFomcDb();
    let geminiCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.search.brave.com")) {
        return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        geminiCalls += 1;
        return new Response("unexpected", { status: 500 });
      }
      if (url === PRESS_CONFERENCE_URL) {
        return new Response(`<html><div id="content" role="main">${"Video instructions and navigation. ".repeat(100)}</div></html>`, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));

    const result = await refreshFomcCommentary(createFomcEnv(db), {
      eventType: "press_conference",
      meetingDate: "2026-07-29",
      sourceUrl: PRESS_CONFERENCE_URL,
      now: new Date("2026-07-29T20:00:00.000Z"),
    });

    expect(result.ok).toBe(false);
    expect(geminiCalls).toBe(0);
    expect(db.rows[0]?.status).toBe("pending_source");
    expect(db.rows[0]?.error).toContain("statement link");
  });

  it("skips Brave collection when an explicit official source is ready and unchanged", async () => {
    const sourceTextHash = await sha256Hex(testExports.normalizeSourceTextForHash(LONG_OFFICIAL_TEXT));
    const db = new FakeFomcDb([createReadyFomcRow(sourceTextHash)]);
    const counts = stubFomcFetches();

    const result = await refreshFomcCommentary(createFomcEnv(db), {
      eventType: "minutes",
      meetingDate: "2026-06-17",
      sourceUrl: OFFICIAL_URL,
      now: new Date("2026-06-18T12:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(counts.official).toBe(1);
    expect(counts.brave).toBe(0);
    expect(counts.gemini).toBe(0);
    expect(db.rows[0]?.lastUnchangedAt).toBe("2026-06-18T12:00:00.000Z");
  });

  it("retries an unchanged extractive fallback and replaces it after Gemini recovers", async () => {
    const sourceTextHash = await sha256Hex(testExports.normalizeSourceTextForHash(LONG_OFFICIAL_TEXT));
    const existing = {
      ...createReadyFomcRow(sourceTextHash),
      provider: "extractive_fallback",
      model: "official-fed-text",
      lastRefreshAttemptAt: "2026-07-30T00:00:00.000Z",
      refreshAttemptCount: 1,
    };
    const db = new FakeFomcDb([existing]);
    const counts = stubFomcFetches();

    const result = await refreshFomcCommentary(createFomcEnv(db), {
      eventType: "minutes",
      meetingDate: "2026-06-17",
      sourceUrl: OFFICIAL_URL,
      now: new Date("2026-07-30T02:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(counts.brave).toBe(0);
    expect(counts.gemini).toBe(1);
    expect(db.rows[0]?.provider).toBe("gemini");
    expect(db.rows[0]?.refreshAttemptCount).toBe(2);
  });

  it("collects Brave context and regenerates when official source text changes", async () => {
    const db = new FakeFomcDb([createReadyFomcRow("old-hash")]);
    const counts = stubFomcFetches(`${LONG_OFFICIAL_TEXT} The Committee added a new sentence about balance sheet policy.`);

    const result = await refreshFomcCommentary(createFomcEnv(db), {
      eventType: "minutes",
      meetingDate: "2026-06-17",
      sourceUrl: OFFICIAL_URL,
      now: new Date("2026-06-18T12:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(counts.official).toBe(1);
    expect(counts.brave).toBe(3);
    expect(counts.gemini).toBe(1);
    expect(db.rows[0]?.status).toBe("ready");
    expect(db.rows[0]?.sourceMode).toBe("official_plus_brave");
    expect(db.rows[0]?.refreshAttemptCount).toBe(1);
  });

  it("can still use Brave discovery when no explicit source URL is known", async () => {
    const db = new FakeFomcDb();
    const counts = stubFomcFetches();

    const result = await refreshFomcCommentary(createFomcEnv(db), {
      eventType: "minutes",
      meetingDate: "2026-06-17",
      now: new Date("2026-06-18T12:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(counts.brave).toBe(3);
    expect(counts.official).toBe(1);
    expect(counts.gemini).toBe(1);
    expect(db.rows[0]?.sourceUrl).toBe(OFFICIAL_URL);
  });

  it("runs scheduled FOMC refresh hourly outside release windows", async () => {
    const env = createFomcEnv(new FakeFomcDb());
    await expect(shouldRunScheduledFomcRefresh(env, new Date("2026-06-18T12:00:00.000Z"))).resolves.toBe(true);
    await expect(shouldRunScheduledFomcRefresh(env, new Date("2026-06-18T12:05:00.000Z"))).resolves.toBe(true);
    await expect(shouldRunScheduledFomcRefresh(env, new Date("2026-06-18T12:10:00.000Z"))).resolves.toBe(true);
    await expect(shouldRunScheduledFomcRefresh(env, new Date("2026-06-18T12:15:00.000Z"))).resolves.toBe(false);
    await expect(shouldRunScheduledFomcRefresh(env, new Date("2026-06-18T12:30:00.000Z"))).resolves.toBe(false);
    await expect(shouldRunScheduledFomcRefresh(env, new Date("2026-06-18T12:45:00.000Z"))).resolves.toBe(false);
  });

  it("runs scheduled FOMC refresh on every release-window tick for relevant FOMC days", async () => {
    const db = new FakeFomcDb([{ ...createReadyFomcRow("hash"), eventType: "press_conference", meetingDate: "2026-06-17" }]);
    await expect(shouldRunScheduledFomcRefresh(createFomcEnv(db), new Date("2026-06-17T18:15:00.000Z"))).resolves.toBe(true);
    await expect(shouldRunScheduledFomcRefresh(createFomcEnv(db), new Date("2026-06-17T18:30:00.000Z"))).resolves.toBe(true);
    await expect(shouldRunScheduledFomcRefresh(createFomcEnv(db), new Date("2026-06-17T18:45:00.000Z"))).resolves.toBe(true);
  });

  it("falls back to hourly scheduled FOMC behavior when release-window metadata lookup fails", async () => {
    const env = {
      DB: {
        prepare() {
          throw new Error("D1 unavailable");
        },
      },
    } as unknown as Env;
    await expect(shouldRunScheduledFomcRefresh(env, new Date("2026-06-17T18:30:00.000Z"))).resolves.toBe(false);
    await expect(shouldRunScheduledFomcRefresh(env, new Date("2026-06-17T18:05:00.000Z"))).resolves.toBe(true);
  });
});
