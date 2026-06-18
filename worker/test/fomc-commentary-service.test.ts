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
            sourceText: bound[6] == null ? null : String(bound[6]),
            sourceFetchedAt: bound[7] == null ? null : String(bound[7]),
            sourceMode: bound[8] as FakeFomcStoredRow["sourceMode"],
            braveSourcesJson: String(bound[9]),
            citationSourcesJson: String(bound[10]),
            summaryMarkdown: bound[11] == null ? null : String(bound[11]),
            highlightsJson: String(bound[12]),
            tradingReadThrough: bound[13] == null ? null : String(bound[13]),
            provider: bound[14] == null ? null : String(bound[14]),
            model: bound[15] == null ? null : String(bound[15]),
            status: bound[16] as FakeFomcStoredRow["status"],
            error: bound[17] == null ? null : String(bound[17]),
            generatedAt: bound[18] == null ? null : String(bound[18]),
            sourceTextHash: bound[19] == null ? null : String(bound[19]),
            lastCheckedAt: bound[20] == null ? null : String(bound[20]),
            lastUnchangedAt: bound[21] == null ? null : String(bound[21]),
            lastRefreshAttemptAt: bound[22] == null ? null : String(bound[22]),
            refreshAttemptCount: Number(bound[23] ?? 0),
            createdAt: String(bound[24]),
            updatedAt: String(bound[25]),
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

  it("normalizes source text before hash comparison", () => {
    expect(testExports.normalizeSourceTextForHash("A\n\n  B\tC")).toBe("A B C");
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

  it("can build an official-source extractive fallback when Gemini is unavailable", () => {
    const fallback = testExports.buildExtractiveFomcSummary({
      eventType: "minutes",
      meetingDate: "2026-04-29",
      officialText: "The Committee decided to maintain the target range for the federal funds rate. Inflation remains somewhat elevated and the Committee remains attentive to inflation risks. Labor market conditions remained solid with low unemployment. The economic outlook is uncertain and risks are balanced.",
    });
    expect(fallback.highlights.length).toBeGreaterThan(0);
    expect(fallback.summaryMarkdown).toContain("Policy signal");
    expect(fallback.tradingReadThrough).toContain("extractive fallback");
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
    expect(db.rows[0]?.refreshAttemptCount).toBe(2);
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
