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

vi.mock("unpdf", () => ({
  getDocumentProxy: vi.fn(async (bytes: Uint8Array) => ({
    bytes,
    numPages: 3,
    async destroy() {},
  })),
  extractText: vi.fn(async (pdf: { bytes: Uint8Array; numPages: number }) => ({
    totalPages: pdf.numPages,
    text: new TextDecoder().decode(pdf.bytes),
  })),
}));

const row = {
  id: "item-1",
  eventType: "minutes" as const,
  meetingDate: "2026-06-17",
  releaseDate: "2026-07-08",
  sourceUrl: "https://www.federalreserve.gov/monetarypolicy/fomcminutes20260617.htm",
  sourceTitle: "Minutes",
  statementUrl: null,
  transcriptUrl: null,
  transcriptKind: null,
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
const TRANSCRIPT_URL = "https://www.federalreserve.gov/mediacenter/files/FOMCpresconf20260729.pdf";
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
const JULY_OPENING_STATEMENT = [
  "Transcript of Chairman Warsh's Press Conference Opening Statement",
  "CHAIRMAN WARSH. Today our Committee voted to maintain the target range for the federal funds rate at 3-1/2 to 3-3/4 percent.",
  ...Array.from({ length: 24 }, () => (
    "The economy is showing resilience, job gains have kept pace with the workforce, and inflation remains elevated relative to the Committee's two percent goal. Monetary policy decisions will respond to incoming data, evolving risks, and the balance sheet."
  )),
].join("\n");
const JULY_FULL_TRANSCRIPT = [
  "Transcript of Chairman Warsh's Press Conference",
  "CHAIRMAN WARSH. Today our Committee voted to maintain the target range for the federal funds rate at 3-1/2 to 3-3/4 percent.",
  ...Array.from({ length: 22 }, () => (
    "Inflation remains elevated, labor market conditions are stable, and the outlook is uncertain. The Committee will respond to incoming data and changes in the balance of risks."
  )),
  "REPORTER SMITH. How should markets interpret the path ahead?",
  "CHAIRMAN WARSH. The path is not preset, and our decisions will depend on the totality of the incoming data and the evolving outlook.",
].join("\n");

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
  transcriptUrl: string | null;
  transcriptKind: "opening_statement" | "full_transcript" | null;
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
        if (normalized.includes("transcript_url IS NULL OR transcript_kind IS NULL")) {
          return (db.rows
            .filter((item) => item.eventType === "press_conference" && item.status === "ready" && (!item.transcriptUrl || !item.transcriptKind))
            .sort((left, right) => right.meetingDate.localeCompare(left.meetingDate))[0] ?? null) as T;
        }
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
          const limit = Number(bound[0] ?? db.rows.length);
          const rows = [...db.rows]
            .sort((left, right) => (
              right.meetingDate.localeCompare(left.meetingDate)
              || (left.eventType === "press_conference" ? 0 : 1) - (right.eventType === "press_conference" ? 0 : 1)
              || String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
            ))
            .slice(0, limit);
          return { results: rows as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        if (normalized.startsWith("UPDATE fomc_commentary_items")) {
          const isUnchanged = normalized.includes("last_unchanged_at = ?");
          const idIndex = isUnchanged ? 10 : 9;
          const item = db.rows.find((candidate) => candidate.id === String(bound[idIndex]));
          if (item && isUnchanged) {
            item.releaseDate = bound[0] == null ? item.releaseDate : String(bound[0]);
            item.sourceTitle = bound[1] == null ? item.sourceTitle : String(bound[1]);
            item.statementUrl = bound[2] == null ? item.statementUrl : String(bound[2]);
            item.transcriptUrl = bound[3] == null ? item.transcriptUrl : String(bound[3]);
            item.transcriptKind = bound[4] == null ? item.transcriptKind : bound[4] as FakeFomcStoredRow["transcriptKind"];
            item.rateDecision = bound[5] == null ? item.rateDecision : String(bound[5]);
            item.sourceFetchedAt = bound[6] == null ? item.sourceFetchedAt : String(bound[6]);
            item.error = null;
            item.lastCheckedAt = String(bound[7]);
            item.lastUnchangedAt = String(bound[8]);
            item.updatedAt = String(bound[9]);
          } else if (item) {
            item.releaseDate = bound[0] == null ? item.releaseDate : String(bound[0]);
            item.sourceTitle = bound[1] == null ? item.sourceTitle : String(bound[1]);
            item.statementUrl = bound[2] == null ? item.statementUrl : String(bound[2]);
            item.transcriptUrl = bound[3] == null ? item.transcriptUrl : String(bound[3]);
            item.rateDecision = bound[4] == null ? item.rateDecision : String(bound[4]);
            item.sourceFetchedAt = bound[5] == null ? item.sourceFetchedAt : String(bound[5]);
            item.error = String(bound[6]);
            item.lastCheckedAt = String(bound[7]);
            item.updatedAt = String(bound[8]);
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
            transcriptUrl: bound[7] == null ? null : String(bound[7]),
            transcriptKind: bound[8] == null ? null : bound[8] as FakeFomcStoredRow["transcriptKind"],
            rateDecision: bound[9] == null ? null : String(bound[9]),
            sourceText: bound[10] == null ? null : String(bound[10]),
            sourceFetchedAt: bound[11] == null ? null : String(bound[11]),
            sourceMode: bound[12] as FakeFomcStoredRow["sourceMode"],
            braveSourcesJson: String(bound[13]),
            citationSourcesJson: String(bound[14]),
            summaryMarkdown: bound[15] == null ? null : String(bound[15]),
            highlightsJson: String(bound[16]),
            tradingReadThrough: bound[17] == null ? null : String(bound[17]),
            provider: bound[18] == null ? null : String(bound[18]),
            model: bound[19] == null ? null : String(bound[19]),
            status: bound[20] as FakeFomcStoredRow["status"],
            error: bound[21] == null ? null : String(bound[21]),
            generatedAt: bound[22] == null ? null : String(bound[22]),
            sourceTextHash: bound[23] == null ? null : String(bound[23]),
            lastCheckedAt: bound[24] == null ? null : String(bound[24]),
            lastUnchangedAt: bound[25] == null ? null : String(bound[25]),
            lastRefreshAttemptAt: bound[26] == null ? null : String(bound[26]),
            refreshAttemptCount: Number(bound[27] ?? 0),
            createdAt: String(bound[28]),
            updatedAt: String(bound[29]),
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
      return new Response(`<html><main>${officialText}</main><footer>Last Update: July 08, 2026</footer></html>`, { status: 200 });
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

  it("parses the official release date instead of using the refresh date", () => {
    expect(testExports.extractFedReleaseDate("<footer>Last Update: July 08, 2026</footer>")).toBe("2026-07-08");
    expect(testExports.extractFedReleaseDate("<p>Minutes (Released June 17, 2026 at 2:00 p.m.)</p>")).toBe("2026-06-17");
    expect(testExports.extractFedReleaseDate("<p>No publication date</p>")).toBeNull();
  });

  it("classifies and cleans official transcript text", () => {
    const raw = [
      "July 29, 2026 Chairman Warsh's Press Conference PRELIMINARY",
      "Page 1 of 3",
      "Transcript of Chairman Warsh's Press Conference Opening Statement",
      JULY_OPENING_STATEMENT,
    ].join("\n");
    const cleaned = testExports.cleanOfficialTranscriptText(raw);
    expect(testExports.classifyOfficialTranscript(raw)).toBe("opening_statement");
    expect(testExports.classifyOfficialTranscript(JULY_FULL_TRANSCRIPT)).toBe("full_transcript");
    expect(testExports.isOfficialTranscriptReady(cleaned, "opening_statement")).toBe(true);
    expect(cleaned).not.toContain("Page 1 of 3");
  });

  it("rejects non-PDF and oversized transcript responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>not a pdf</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })));
    await expect(testExports.fetchOfficialFedTranscript(createFomcEnv(new FakeFomcDb()), TRANSCRIPT_URL))
      .rejects.toThrow("not a PDF");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("%PDF-small", {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(6 * 1024 * 1024),
      },
    })));
    await expect(testExports.fetchOfficialFedTranscript(createFomcEnv(new FakeFomcDb()), TRANSCRIPT_URL))
      .rejects.toThrow("5 MB");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("%PDF-\nnot a transcript", {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    })));
    await expect(testExports.fetchOfficialFedTranscript(createFomcEnv(new FakeFomcDb()), TRANSCRIPT_URL))
      .rejects.toThrow("not substantive enough");
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

  it("orders commentary by meeting date with press conference first for a tie", async () => {
    const juneMinutes = createReadyFomcRow("june-minutes");
    juneMinutes.id = "june-minutes";
    juneMinutes.releaseDate = "2026-07-30";
    const junePress: FakeFomcStoredRow = {
      ...createReadyFomcRow("june-press"),
      id: "june-press",
      eventType: "press_conference",
      releaseDate: "2026-06-17",
      transcriptUrl: "https://www.federalreserve.gov/mediacenter/files/FOMCpresconf20260617.pdf",
      transcriptKind: "full_transcript",
    };
    const julyPress: FakeFomcStoredRow = {
      ...junePress,
      id: "july-press",
      meetingDate: "2026-07-29",
      releaseDate: "2026-07-29",
      sourceUrl: PRESS_CONFERENCE_URL,
      transcriptUrl: TRANSCRIPT_URL,
      transcriptKind: "opening_statement",
    };
    const items = await loadLatestFomcCommentary(createFomcEnv(new FakeFomcDb([juneMinutes, junePress, julyPress])), 4);
    expect(items.map((item) => item.id)).toEqual(["july-press", "june-press", "june-minutes"]);
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
    ["The Committee decided to maintain the target range for the federal funds rate at 3‑1/2 to 3‑3/4 percent.", "Held at 3.50%–3.75%"],
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
      transcriptUrl: "https://www.federalreserve.gov/mediacenter/files/FOMCpresconf20260617.pdf",
      transcriptKind: "full_transcript",
      status: "ready",
    });
    const latestMinutes = normalizeFomcCommentaryRow({ ...row, id: "latest-minutes", status: "ready" });
    expect(testExports.hasReadyLatestFomcTypes([currentPress, latestMinutes, olderPress])).toBe(false);
    expect(testExports.hasReadyLatestFomcTypes([{
      ...currentPress,
      status: "ready",
      transcriptUrl: TRANSCRIPT_URL,
      transcriptKind: "opening_statement",
    }, latestMinutes, olderPress])).toBe(true);
    expect(testExports.hasVisibleLegacyPressConference([olderPress, latestMinutes])).toBe(false);
    expect(testExports.hasVisibleLegacyPressConference([{ ...olderPress, transcriptUrl: null, transcriptKind: null }, latestMinutes])).toBe(true);
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
            <footer>Last Update: July 29, 2026</footer>
          </div></html>
        `, { status: 200 });
      }
      if (url === STATEMENT_URL) {
        return new Response(`<html><title>Federal Reserve issues FOMC statement</title><div class="col-xs-12 col-sm-8 col-md-8"><p>${JULY_STATEMENT}</p></div></html>`, { status: 200 });
      }
      if (url === TRANSCRIPT_URL) {
        return new Response(new TextEncoder().encode(`%PDF-\n${JULY_OPENING_STATEMENT}`), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
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
    expect(fetchedUrls).toContain(TRANSCRIPT_URL);
    expect(db.rows[0]?.sourceUrl).toBe(PRESS_CONFERENCE_URL);
    expect(db.rows[0]?.statementUrl).toBe(STATEMENT_URL);
    expect(db.rows[0]?.transcriptUrl).toBe(TRANSCRIPT_URL);
    expect(db.rows[0]?.transcriptKind).toBe("opening_statement");
    expect(db.rows[0]?.rateDecision).toBe("Held at 3.50%–3.75%");
    expect(db.rows[0]?.provider).toBe("extractive_fallback");
    expect(db.rows[0]?.sourceMode).toBe("official");
    expect(db.rows[0]?.sourceText).toContain("CHAIRMAN WARSH");
    expect(db.rows[0]?.sourceText).not.toContain("Voting against");
    expect(db.rows[0]?.summaryMarkdown).toMatch(/inflation remains elevated/i);
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

  it("keeps a press conference pending when the statement exists but the transcript is missing", async () => {
    const db = new FakeFomcDb();
    let geminiCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("generativelanguage.googleapis.com")) {
        geminiCalls += 1;
        return new Response("unexpected", { status: 500 });
      }
      if (url === PRESS_CONFERENCE_URL) {
        return new Response(`
          <html><a href="/newsevents/pressreleases/monetary20260729a.htm">FOMC Meeting Statement</a>
          <footer>Last Update: July 29, 2026</footer></html>
        `, { status: 200 });
      }
      if (url === STATEMENT_URL) {
        return new Response(`<html><main>${JULY_STATEMENT}</main><footer>Last Update: July 29, 2026</footer></html>`, { status: 200 });
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
    expect(db.rows[0]?.rateDecision).toBeTruthy();
    expect(db.rows[0]?.summaryMarkdown).toBeNull();
    expect(db.rows[0]?.error).toContain("transcript has not been published");
  });

  it("preserves a valid transcript summary when a later PDF fetch fails", async () => {
    const existing: FakeFomcStoredRow = {
      ...createReadyFomcRow("transcript-hash"),
      id: "existing-press",
      eventType: "press_conference",
      meetingDate: "2026-07-29",
      releaseDate: "2026-07-29",
      sourceUrl: PRESS_CONFERENCE_URL,
      statementUrl: STATEMENT_URL,
      transcriptUrl: TRANSCRIPT_URL,
      transcriptKind: "opening_statement",
      sourceText: JULY_OPENING_STATEMENT,
      provider: "gemini",
      summaryMarkdown: "## Policy signal\nExisting transcript summary.",
    };
    const db = new FakeFomcDb([existing]);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === PRESS_CONFERENCE_URL) {
        return new Response(`
          <html>
            <a href="/newsevents/pressreleases/monetary20260729a.htm">FOMC Meeting Statement</a>
            <a href="/mediacenter/files/FOMCpresconf20260729.pdf">Press Conference Transcript (PDF)</a>
            <footer>Last Update: July 29, 2026</footer>
          </html>
        `, { status: 200 });
      }
      if (url === STATEMENT_URL) return new Response(`<html><main>${JULY_STATEMENT}</main></html>`, { status: 200 });
      if (url === TRANSCRIPT_URL) return new Response("temporarily unavailable", { status: 503 });
      return new Response("not found", { status: 404 });
    }));

    const result = await refreshFomcCommentary(createFomcEnv(db), {
      eventType: "press_conference",
      meetingDate: "2026-07-29",
      sourceUrl: PRESS_CONFERENCE_URL,
      now: new Date("2026-07-30T05:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(db.rows[0]?.status).toBe("ready");
    expect(db.rows[0]?.summaryMarkdown).toContain("Existing transcript summary");
    expect(db.rows[0]?.error).toContain("serving previous transcript summary");
  });

  it("replaces a preliminary opening statement when the transcript PDF content changes", async () => {
    const openingHash = await sha256Hex(testExports.normalizeSourceTextForHash(JULY_OPENING_STATEMENT));
    const existing: FakeFomcStoredRow = {
      ...createReadyFomcRow(openingHash),
      id: "existing-press",
      eventType: "press_conference",
      meetingDate: "2026-07-29",
      releaseDate: "2026-07-29",
      sourceUrl: PRESS_CONFERENCE_URL,
      statementUrl: STATEMENT_URL,
      transcriptUrl: TRANSCRIPT_URL,
      transcriptKind: "opening_statement",
      sourceText: JULY_OPENING_STATEMENT,
      provider: "gemini",
      refreshAttemptCount: 2,
    };
    const db = new FakeFomcDb([existing]);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.search.brave.com")) {
        return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  highlights: ["Full transcript now available"],
                  tradingReadThrough: "Policy remains data dependent.",
                  summaryMarkdown: "## Policy signal\nFull transcript.",
                  usedCitationUrls: [],
                }),
              }],
            },
            groundingMetadata: { groundingChunks: [] },
          }],
        }), { status: 200 });
      }
      if (url === PRESS_CONFERENCE_URL) {
        return new Response(`
          <html>
            <a href="/newsevents/pressreleases/monetary20260729a.htm">FOMC Meeting Statement</a>
            <a href="/mediacenter/files/FOMCpresconf20260729.pdf">Press Conference Transcript (PDF)</a>
            <footer>Last Update: July 29, 2026</footer>
          </html>
        `, { status: 200 });
      }
      if (url === STATEMENT_URL) return new Response(`<html><main>${JULY_STATEMENT}</main></html>`, { status: 200 });
      if (url === TRANSCRIPT_URL) {
        return new Response(new TextEncoder().encode(`%PDF-\n${JULY_FULL_TRANSCRIPT}`), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      }
      return new Response("not found", { status: 404 });
    }));

    const result = await refreshFomcCommentary(createFomcEnv(db), {
      eventType: "press_conference",
      meetingDate: "2026-07-29",
      sourceUrl: PRESS_CONFERENCE_URL,
      now: new Date("2026-07-30T06:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(db.rows[0]?.transcriptKind).toBe("full_transcript");
    expect(db.rows[0]?.sourceText).toContain("REPORTER SMITH");
    expect(db.rows[0]?.sourceTextHash).not.toBe(openingHash);
    expect(db.rows[0]?.refreshAttemptCount).toBe(1);
  });

  it("skips Brave collection when an explicit official source is ready and unchanged", async () => {
    const sourceTextHash = await sha256Hex(testExports.normalizeSourceTextForHash(LONG_OFFICIAL_TEXT));
    const db = new FakeFomcDb([{ ...createReadyFomcRow(sourceTextHash), releaseDate: "2026-07-30" }]);
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
    expect(db.rows[0]?.releaseDate).toBe("2026-07-08");
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
