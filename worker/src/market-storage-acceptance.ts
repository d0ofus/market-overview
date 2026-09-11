import { z } from "zod";
import { buildEodCatalogRow, EOD_CATALOG_METHODOLOGY_VERSION, EOD_CATALOG_SCOPE, loadEodCatalogRows } from "./eod-catalog-service";
import { EOD_PUBLICATION_SCOPES } from "./eod-coordinator";
import { MARKET_HISTORY_REQUIRED_CONSUMERS, MARKET_HISTORY_READER_CONTRACT_VERSION } from "./eod-history-maintenance";
import { computeEodTickerMetrics, EOD_METRICS_VERSION, type EodMetricBar } from "./eod-metrics";
import { decodeEodPayload, type EodStoredPayload } from "./eod-publication-codec";
import { eodHash } from "./eod-publication-service";
import { EOD_YAHOO_ARCHIVE_LAYOUT, storageFallbackModelValid } from "./eod-storage-layout";
import { loadMarketHistory, loadMarketHistoryCoverage, loadMarketHistoryOhlcv, type MarketHistoryBar } from "./market-history";
import type { StorageMigrationIdentity } from "./market-storage-control";
import type { Env } from "./types";
import { createStorageCapturedReadCache } from "./market-storage-read-cache";

/** These are executable reader/output contracts, not a list of asserted booleans.
 * MAX is read once per provider/security; trailing readers are invoked separately
 * so a broken SQL limit or missing archived window cannot pass via array slicing. */
export const STORAGE_CONSUMER_CONTRACT_VERSION = 1;
export const STORAGE_CONSUMER_CONTRACTS = [
  "ticker-max", "patterns-520", "correlation-5y", "watchlist", "relative-strength",
  "scans", "overview", "breadth", "earnings-gaps", "coverage-and-repair",
] as const;
type Consumer = typeof STORAGE_CONSUMER_CONTRACTS[number];
type Capture = { schemaHash: string; revision: number };
export type StorageAcceptanceCapture = {
  identity: StorageMigrationIdentity; captureHash: string;
  sourceCapture: Capture; targetCapture: Capture; historyCapture: Capture;
};
export type StorageConsumerCheckpoint = {
  version: 1; inputHash: string; tickerHash: string; tickerCount: number; nextTicker: number;
  outputHash: string; checks: Record<Consumer, { tickers: number; observations: number; hash: string }>;
  history: { missing: number; shorterThan520: number; shorterThan1330: number };
};
export type StorageConsumerEvidence = StorageConsumerCheckpoint & {
  completedAt: string; captureHash: string; identity: StorageMigrationIdentity;
  readerContractVersion: number; evidenceHash: string;
};
const hashPattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[A-Z0-9][A-Z0-9.^=/-]{0,39}$/;
function fail(reason: string): never { throw new Error(`storage-acceptance-${reason}`); }
function population(values: readonly string[]): string[] {
  const tickers = [...values].sort();
  if (!tickers.length || tickers.length > 20_000 || new Set(tickers).size !== tickers.length
    || tickers.some((value) => !identifierPattern.test(value))) fail("invalid-full-population");
  return tickers;
}
function count(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function barIdentity(bars: MarketHistoryBar[]): unknown[] {
  return bars.map((bar) => [bar.feed, bar.ticker, bar.date, bar.o, bar.h, bar.l, bar.c, bar.volume,
    bar.reportedVolume ?? null, bar.reportedVolumeCollectedAt ?? null, bar.sourceProvider, bar.adjustment,
    bar.observedAt, bar.fetchedAt]);
}
function metricBars(bars: MarketHistoryBar[]): EodMetricBar[] {
  return bars.filter((bar) => bar.adjustment === "split" && ["alpaca", "yahoo"].includes(bar.sourceProvider))
    .map((bar) => ({ ticker: bar.ticker, sessionDate: bar.date, close: bar.c, open: bar.o, high: bar.h, low: bar.l,
      reportedVolume: bar.reportedVolume ?? null, sourceProvider: bar.sourceProvider as "alpaca" | "yahoo",
      priceBasis: "split", sourceFeed: bar.feed, collectedAt: bar.observedAt,
      reportedVolumeCollectedAt: bar.reportedVolumeCollectedAt ?? null }));
}

/** No database writes. The caller must supply the verifier's actual read-only
 * fence check; it must check all three captured databases before and after each
 * batch. Checkpoints belong to the durable migration lease, never Actions cache. */
export async function verifyStorageConsumerBatch(input: {
  sourceEnv: Env; targetEnv: Env; capture: StorageAcceptanceCapture; tickers: readonly string[];
  calendarDates: readonly string[]; checkpoint?: StorageConsumerCheckpoint; maxTickers?: number;
  assertCapture: () => Promise<void>;
}): Promise<{ checkpoint: StorageConsumerCheckpoint; evidence: StorageConsumerEvidence | null }> {
  const tickers = population(input.tickers), session = input.capture.identity.sessionDate;
  const calendar = [...input.calendarDates];
  if (!calendar.length || calendar.at(-1) !== session || new Set(calendar).size !== calendar.length
    || calendar.some((day, index) => !/^\d{4}-\d{2}-\d{2}$/.test(day) || (index > 0 && day <= calendar[index - 1]))) fail("invalid-exchange-calendar");
  if (!hashPattern.test(input.capture.captureHash)) fail("invalid-capture-hash");
  const tickerHash = await eodHash(tickers);
  const inputHash = await eodHash([STORAGE_CONSUMER_CONTRACT_VERSION, input.capture, tickers, calendar]);
  const max = input.maxTickers ?? 1;
  if (!Number.isInteger(max) || max < 1 || max > 10) fail("invalid-batch-size");
  const emptyHash = await eodHash([]);
  const state: StorageConsumerCheckpoint = input.checkpoint ? structuredClone(input.checkpoint) : {
    version: 1, inputHash, tickerHash, tickerCount: tickers.length, nextTicker: 0, outputHash: emptyHash,
    checks: Object.fromEntries(STORAGE_CONSUMER_CONTRACTS.map((name) => [name, { tickers: 0, observations: 0, hash: emptyHash }])) as StorageConsumerCheckpoint["checks"],
    history: { missing: 0, shorterThan520: 0, shorterThan1330: 0 },
  };
  if (state.version !== 1 || state.inputHash !== inputHash || state.tickerHash !== tickerHash || state.tickerCount !== tickers.length
    || !count(state.nextTicker) || state.nextTicker > tickers.length || !hashPattern.test(state.outputHash)
    || STORAGE_CONSUMER_CONTRACTS.some((name) => state.checks[name]?.tickers !== state.nextTicker
      || !count(state.checks[name]?.observations) || !hashPattern.test(state.checks[name]?.hash))
    || Object.values(state.history).some((value) => !count(value) || value > state.nextTicker)) fail("checkpoint-capture-mismatch");
  await input.assertCapture();
  const end = Math.min(tickers.length, state.nextTicker + max);
  const cached=createStorageCapturedReadCache();
  const readers=(env:Env):Env => ({...env,DB:cached(env.DB),
    ...(env.MARKET_DATA_DB ? {MARKET_DATA_DB:cached(env.MARKET_DATA_DB)} : {}),
    ...(env.MARKET_HISTORY_DB ? {MARKET_HISTORY_DB:cached(env.MARKET_HISTORY_DB)} : {}),
    EOD_RUNNER_MODE:"shadow",ALPACA_DAILY_FEED:"sip"});
  const sourceEnv=readers(input.sourceEnv),targetEnv=readers(input.targetEnv);
  const request={tickers:tickers.slice(state.nextTicker,end),endDate:session,feed:"sip"};
  // Execute each actual reader once for the whole bounded ticker group. The
  // 520/1330 SQL limits and coverage query remain independent contracts; the
  // cache only shares identical captured reads, never a substitute array slice.
  const [allSource,allTarget,allSourceYahoo,allTargetYahoo,allOhlcv520,allCloses1330,allCoverage]=await Promise.all([
    loadMarketHistory(sourceEnv,request),loadMarketHistory(targetEnv,request),
    loadMarketHistory(sourceEnv,{...request,feed:"yahoo-eod"}),loadMarketHistory(targetEnv,{...request,feed:"yahoo-eod"}),
    loadMarketHistoryOhlcv(targetEnv,{...request,limitPerTicker:520}),
    // 1,300 closing observations and the existing thirty-observation buffer.
    loadMarketHistory(targetEnv,{...request,limitPerTicker:1_330}),loadMarketHistoryCoverage(targetEnv,request),
  ]);
  const grouped=(rows:MarketHistoryBar[]):Map<string,MarketHistoryBar[]> => {
    const result=new Map<string,MarketHistoryBar[]>();
    for (const row of rows) {const group=result.get(row.ticker) ?? [];group.push(row);result.set(row.ticker,group);}
    return result;
  };
  const sourceRows=grouped(allSource),targetRows=grouped(allTarget),sourceYahooRows=grouped(allSourceYahoo),targetYahooRows=grouped(allTargetYahoo),
    ohlcvRows=grouped(allOhlcv520),closeRows=grouped(allCloses1330);
  for (let index = state.nextTicker; index < end; index++) {
    const ticker=tickers[index],source=sourceRows.get(ticker) ?? [],target=targetRows.get(ticker) ?? [],
      sourceYahoo=sourceYahooRows.get(ticker) ?? [],targetYahoo=targetYahooRows.get(ticker) ?? [];
    const compare = async (name: Consumer, expected: unknown, actual: unknown, observations: number) => {
      const expectedHash = await eodHash(expected), actualHash = await eodHash(actual);
      if (expectedHash !== actualHash) fail(`consumer-mismatch:${name}:${ticker}`);
      const check = state.checks[name];
      check.tickers++; check.observations += observations; check.hash = await eodHash([check.hash, ticker, expectedHash, observations]);
    };
    await compare("ticker-max", [barIdentity(source), barIdentity(sourceYahoo)], [barIdentity(target), barIdentity(targetYahoo)], source.length + sourceYahoo.length);
    const ohlcv520=ohlcvRows.get(ticker) ?? [],closes1330=closeRows.get(ticker) ?? [];
    const expectedOhlcv = source.slice(-520).map((bar) => ({ ...bar, volume: bar.volume ?? 0 }));
    await compare("patterns-520", barIdentity(expectedOhlcv), barIdentity(ohlcv520), expectedOhlcv.length);
    const closeOutput = (bars: MarketHistoryBar[]) => bars.map((bar) => [bar.date, bar.c]);
    await compare("correlation-5y", closeOutput(source.slice(-1_330)), closeOutput(closes1330), Math.min(1_330, source.length));
    const expectedCoverage = source.length ? [[ticker, { ticker, firstDate: source[0].date, lastDate: source.at(-1)!.date, barCount: source.length }]] : [];
    await compare("coverage-and-repair", expectedCoverage, allCoverage.has(ticker) ? [[ticker,allCoverage.get(ticker)!]] : [], source.length);
    const ohlcvOutput = (bars: MarketHistoryBar[]) => bars.map((bar) => [bar.date, bar.o, bar.h, bar.l, bar.c, bar.volume ?? 0]);
    // These workflows share the range/ordered OHLCV contract. Their algorithms
    // retain identical inputs including gaps, null-volume compatibility and dates.
    await compare("watchlist", ohlcvOutput(source), ohlcvOutput(target), source.length);
    await compare("relative-strength", ohlcvOutput(source), ohlcvOutput(target), source.length);
    await compare("earnings-gaps", ohlcvOutput(source), ohlcvOutput(target), source.length);
    await compare("scans", buildEodCatalogRow(ticker, source, 0), buildEodCatalogRow(ticker, target, 0), source.length);
    const metrics = (bars: MarketHistoryBar[]) => computeEodTickerMetrics({ ticker, targetSession: session, calendarDates: calendar, bars: metricBars(bars) });
    const sourceMetrics = metrics([...source, ...sourceYahoo]), targetMetrics = metrics([...target, ...targetYahoo]);
    await compare("overview", sourceMetrics, targetMetrics, source.length + sourceYahoo.length);
    await compare("breadth", sourceMetrics, targetMetrics, source.length + sourceYahoo.length);
    state.history.missing += Number(source.length === 0);
    state.history.shorterThan520 += Number(source.length < 520);
    state.history.shorterThan1330 += Number(source.length < 1_330);
    state.nextTicker = index + 1;
    state.outputHash = await eodHash([state.outputHash, ticker, state.checks]);
  }
  await input.assertCapture();
  if (state.nextTicker !== tickers.length) return { checkpoint: state, evidence: null };
  const unsigned = { ...state, completedAt: new Date().toISOString(), captureHash: input.capture.captureHash,
    identity: input.capture.identity, readerContractVersion: MARKET_HISTORY_READER_CONTRACT_VERSION };
  return { checkpoint: state, evidence: { ...unsigned, evidenceHash: await eodHash(unsigned) } };
}

export async function validateStorageConsumerEvidence(evidence: StorageConsumerEvidence, capture: StorageAcceptanceCapture,
  tickersInput: readonly string[]): Promise<void> {
  const { evidenceHash, ...unsigned } = evidence;
  const tickers = population(tickersInput);
  if (await eodHash(unsigned) !== evidenceHash || evidence.captureHash !== capture.captureHash
    || await eodHash(evidence.identity) !== await eodHash(capture.identity)
    || evidence.tickerHash !== await eodHash(tickers) || evidence.nextTicker !== tickers.length || evidence.tickerCount !== tickers.length
    || evidence.readerContractVersion !== MARKET_HISTORY_READER_CONTRACT_VERSION || evidence.version !== 1
    || MARKET_HISTORY_REQUIRED_CONSUMERS.some((consumer) => !STORAGE_CONSUMER_CONTRACTS.includes(consumer))
    || STORAGE_CONSUMER_CONTRACTS.some((consumer) => evidence.checks[consumer]?.tickers !== tickers.length
      || !count(evidence.checks[consumer]?.observations) || !hashPattern.test(evidence.checks[consumer]?.hash))) fail("consumer-proof-incomplete");
}

type PublicationRow = EodStoredPayload & { id: string; scope: string; sessionDate: string; status: string;
  checksum: string; methodologyVersion: string; acceptedAt: string | null; revision: number };
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function stringList(value: unknown): string[] { return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []; }
function overviewManifest(value: unknown, configured: boolean): unknown[] {
  const sections = object(value).sections;
  if (!Array.isArray(sections) || !sections.length) fail("overview-sections-missing");
  return sections.map((sectionValue) => {
    const section = object(sectionValue);
    if (typeof section.id !== "string" || !Array.isArray(section.groups)) fail("overview-groups-missing");
    return [section.id, section.groups.map((groupValue) => {
      const group = object(groupValue), items = configured ? group.items : group.rows;
      if (typeof group.id !== "string" || !Array.isArray(items)) fail("overview-rows-missing");
      const rows = items.map(object).filter((row) => !configured || row.enabled === true);
      if (rows.some((row) => typeof row.ticker !== "string")) fail("overview-ticker-missing");
      return [group.id, rows.map((row) => row.ticker)];
    })];
  });
}
export type StoragePublicationEvidence = {
  version: 1; identity: StorageMigrationIdentity; runId: string; sessionDate: string; inputClock: number;
  tickerHash: string; tickerCount: number; checkedAt: string;
  scopes: Array<{ scope: string; id: string; revision: number; checksum: string }>;
  membershipHash: string; catalogHash: string; evidenceHash: string;
};

/** Seven already-verified stored rows for an offline physical growth fixture.
 * No financial observation or publication is inserted by this collection. */
export async function collectStoragePublicationGrowthSamples(env: Env, evidence: StoragePublicationEvidence, sourceSchemaHash: string): Promise<{
  version: 1; identity: StorageMigrationIdentity; tickerHash: string; sourceSchemaHash: string;
  publicationEvidenceHash: string; samplesHash: string; rows: Array<Record<string, unknown>>;
}> {
  const { evidenceHash, ...unsigned } = evidence;
  if (!env.MARKET_DATA_DB || evidence.scopes.length !== 7 || await eodHash(unsigned) !== evidenceHash
    || !hashPattern.test(sourceSchemaHash)) fail("growth-publication-evidence-invalid");
  const rows = await env.MARKET_DATA_DB.prepare(`SELECT id,scope,session_date,revision,input_hash,methodology_version,
    payload_json,payload_checksum,payload_codec,payload_base64,status,created_at,accepted_at FROM eod_publications
    WHERE id IN (SELECT value FROM json_each(?)) ORDER BY scope`).bind(JSON.stringify(evidence.scopes.map((row) => row.id))).all<Record<string, unknown>>();
  if (rows.results.length !== 7 || rows.results.some((row) => row.status !== "accepted" || row.session_date !== evidence.sessionDate
    || !evidence.scopes.some((scope) => scope.id === row.id && scope.checksum === row.payload_checksum && scope.revision === row.revision))) fail("growth-publication-reference-changed");
  return { version: 1, identity: evidence.identity, tickerHash: evidence.tickerHash, sourceSchemaHash,
    publicationEvidenceHash: evidenceHash, samplesHash: await eodHash(rows.results), rows: rows.results };
}

/** Read-only live gate. This does not promote a shadow candidate or trust a
 * caller-supplied success flag. Every pointed publication is decoded/checksummed
 * and matched to the completed run, its membership and the current revision. */
export async function verifyStorageAcceptedPublications(input: {
  env: Env; identity: StorageMigrationIdentity; runId: string; tickers: readonly string[]; expectedSession: string;
}): Promise<StoragePublicationEvidence> {
  const { env } = input, db = env.MARKET_DATA_DB, ops = env.OPS_DB;
  if (!db || !ops || !env.MARKET_HISTORY_DB) fail("publication-bindings-missing");
  const tickers = population(input.tickers), tickerHash = await eodHash(tickers);
  const run = await ops.prepare(`SELECT status,session_date AS sessionDate,mode,completed_at AS completedAt,
    completed_input_clock AS inputClock,input_json AS inputs,progress_json AS progress FROM eod_runs WHERE id=?`)
    .bind(input.runId).first<{ status: string; sessionDate: string; mode: string; completedAt: string | null; inputClock: number; inputs: string; progress: string }>();
  if (!run || run.status !== "completed" || !run.completedAt || run.sessionDate !== input.expectedSession) fail("completed-latest-run-required");
  const frozen = object(JSON.parse(run.inputs)), progress = object(JSON.parse(run.progress));
  if (await eodHash(population(stringList(frozen.tickers))) !== tickerHash || progress.symbols !== tickers.length
    || frozen.methodologyVersion !== EOD_METRICS_VERSION) fail("publication-population-mismatch");
  const clock = async () => db.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first<number>("revision");
  const before = await clock();
  if (!count(run.inputClock) || before !== run.inputClock) fail("publication-inputs-changed");
  const scopes = [...EOD_PUBLICATION_SCOPES, EOD_CATALOG_SCOPE];
  const pointers = await db.prepare(`SELECT p.id,p.scope,p.session_date AS sessionDate,p.status,p.payload_checksum AS checksum,
    p.methodology_version AS methodologyVersion,p.accepted_at AS acceptedAt,p.revision,
    p.payload_json AS payload,p.payload_codec AS payloadCodec,p.payload_base64 AS payloadBase64
    FROM eod_publication_pointers h JOIN eod_publications p ON p.id=h.publication_id
    WHERE h.scope IN (SELECT value FROM json_each(?)) AND h.scope=p.scope AND h.session_date=p.session_date`)
    .bind(JSON.stringify(scopes)).all<PublicationRow>();
  if (pointers.results.length !== scopes.length || new Set(pointers.results.map((row) => row.scope)).size !== scopes.length) fail("accepted-scope-set-incomplete");
  const memberships = Array.isArray(frozen.memberships) ? frozen.memberships.map(object) : [];
  if (memberships.length !== 5 || new Set(memberships.map((row) => row.universeId)).size !== 5) fail("publication-memberships-missing");
  const published = stringList(progress.published), decoded = new Map<string, Record<string, unknown>>();
  for (const row of pointers.results) {
    const catalog = row.scope === EOD_CATALOG_SCOPE;
    if (row.status !== "accepted" || !row.acceptedAt || row.sessionDate !== input.expectedSession
      || row.methodologyVersion !== (catalog ? EOD_CATALOG_METHODOLOGY_VERSION : EOD_METRICS_VERSION)
      || (catalog ? row.id !== progress.catalogPublicationId : !published.includes(row.id))) fail("accepted-publication-reference");
    const payload = object(await decodeEodPayload(row));
    if (!hashPattern.test(row.checksum) || await eodHash(payload) !== row.checksum) fail("accepted-publication-integrity");
    if (!catalog && payload.asOfDate !== input.expectedSession) fail("accepted-payload-session-mismatch");
    decoded.set(row.scope, payload);
    if (row.scope.startsWith("breadth:")) {
      const universe = row.scope.slice(8), member = memberships.find((value) => value.universeId === universe);
      const members = stringList(member?.members), metrics = object(payload.metrics), payloadMembership = object(payload.membership);
      const observed = metrics.memberCount, total = metrics.totalUniverseMembers;
      if (!members.length || new Set(members).size !== members.length || members.some((ticker) => !tickers.includes(ticker))
        || payloadMembership.versionId !== member?.versionId || payload.publishable !== true
        || total !== members.length || typeof observed !== "number" || !count(observed) || observed > members.length
        || observed / members.length < (universe === "sp500-core" ? 0.98 : 0.95)) fail("accepted-breadth-coverage");
    } else if (!catalog && (payload.status !== "ready" || typeof payload.freshnessCurrentCount !== "number" || payload.freshnessCurrentCount < 1)) {
      fail("accepted-overview-unusable");
    }
  }
  const overview = decoded.get("overview:default")!;
  if (await eodHash(overviewManifest(frozen.config, true)) !== await eodHash(overviewManifest(overview, false))) fail("overview-configured-sections-not-preserved");
  const catalog = decoded.get(EOD_CATALOG_SCOPE)!;
  const catalogTickers = (value: unknown) => Array.isArray(value) ? value.map((row) => Array.isArray(row) ? row[0] : null) : [];
  const catalogRows = catalogTickers(catalog.rows), compatibility = object(catalog.compatibility);
  const compatibleRows = catalogTickers(compatibility.rows);
  if (catalog.schemaVersion !== 1 || catalog.sessionDate !== input.expectedSession || compatibility.schemaVersion !== 1
    || await eodHash([...catalogRows].sort()) !== tickerHash || await eodHash([...compatibleRows].sort()) !== tickerHash) fail("catalog-complete-compatibility-required");
  // This checks all tuple semantics, pending repairs and the exact SIP revisions.
  const catalogMap = await loadEodCatalogRows(env, tickers, input.expectedSession);
  if (catalogMap.size !== tickers.length || [...catalogMap.values()].some((row) => !row.compatibility)) fail("catalog-row-compatibility-missing");
  if (await clock() !== before) fail("publication-inputs-changed");
  const unsigned = { version: 1 as const, identity: input.identity, runId: input.runId, sessionDate: input.expectedSession,
    inputClock: run.inputClock, tickerHash, tickerCount: tickers.length, checkedAt: new Date().toISOString(),
    scopes: pointers.results.map((row) => ({ scope: row.scope, id: row.id, revision: row.revision, checksum: row.checksum })).sort((a, b) => a.scope.localeCompare(b.scope)),
    membershipHash: await eodHash(memberships), catalogHash: await eodHash(catalog) };
  return { ...unsigned, evidenceHash: await eodHash(unsigned) };
}

const positive = z.number().int().safe().positive();
const dateTime = z.string().datetime({ offset: true });
const hash = z.string().regex(hashPattern);
/** Physical growth is measured by loading complete publication sets into a
 * disposable copy of the real schema. A zero byte delta or a guessed multiplier
 * is not evidence. Existing rows/indexes are already included in the model. */
export const storagePublicationGrowthSchema = z.object({
  version: z.literal(1), measuredAt: dateTime, codeRevision: z.string().regex(/^[a-f0-9]{40}$/),
  tickerHash: hash, schemaHash: hash, fixtureSha256: hash, beforeBytes: positive, afterBytes: positive,
  measurementMethod: z.literal("sqlite-real-publication-schema-v1"), sourceSnapshotSha256: hash,
  sourcePublicationIds: z.array(z.string().min(1)).length(7), sourcePublicationChecksums: z.array(hash).length(7),
  sourceSessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), samplesHash: hash, publicationEvidenceHash: hash,
  completeSessionSets: positive.min(2), publicationRows: positive.min(14),
  forecastSessions: positive.min(20), revisionsPerSession: positive.min(2),
}).strict();
export type StoragePublicationGrowth = z.infer<typeof storagePublicationGrowthSchema>;
export function storagePublicationGrowthReserve(input: unknown, expected: { codeRevision: string; tickerHash: string; schemaHash: string }): number {
  const parsed = storagePublicationGrowthSchema.safeParse(input);
  if (!parsed.success) fail("publication-growth-measurement-required");
  const proof = parsed.data;
  if (proof.codeRevision !== expected.codeRevision || proof.tickerHash !== expected.tickerHash || proof.schemaHash !== expected.schemaHash
    || proof.afterBytes <= proof.beforeBytes || proof.publicationRows !== proof.completeSessionSets * 7
    || new Set(proof.sourcePublicationIds).size !== 7) fail("publication-growth-identity-mismatch");
  return Math.ceil((proof.afterBytes - proof.beforeBytes) / proof.completeSessionSets) * proof.forecastSessions * proof.revisionsPerSession;
}

/** Reads actual D1 size metadata. A local file or caller assertion cannot stand
 * in for these live measurements. The REST adapter accounts for this query. */
export async function measureStorageLiveBytes(db: D1Database): Promise<number> {
  const result = await db.prepare("SELECT revision FROM market_storage_fence WHERE id='default'").all<{ revision: number }>();
  const bytes = result.meta.size_after;
  if (result.results.length !== 1 || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) fail("live-size-metadata-unavailable");
  return bytes;
}

export async function validateStorageCapacityAnalysis(input: {
  analysis: unknown; publicationGrowth: unknown; identity: StorageMigrationIdentity; tickers: readonly string[];
  sourceSchemaHash: string; sourceSnapshotSha256: string; target: D1Database; history: D1Database; now?: Date;
  publications: StoragePublicationEvidence;
}): Promise<{ hotSessions: 260 | 90; projectedMarketBytes: number; projectedHistoryBytes: number;
  liveTargetBytes: number; liveHistoryBytes: number; publicationGrowthReserveBytes: number;
  forecastSessions: number; revisionsPerSession: number; analysisHash: string; measuredAt: string }> {
  const report = object(input.analysis), source = object(report.source), capture = object(source.capture);
  const populationValue = object(report.population), archive = object(report.archive);
  const tickers = population(input.tickers), tickerHash = await eodHash(tickers), now = input.now ?? new Date();
  const measured = typeof report.measuredAt === "string" ? Date.parse(report.measuredAt) : NaN;
  if (report.version !== 1 || report.sessionDate !== input.identity.sessionDate || !Number.isFinite(measured)
    || measured > now.getTime() || now.getTime() - measured > 86_400_000
    || capture.kind !== "logical-d1-capacity-snapshot" || capture.completeDeclared !== true || capture.partialEstimate !== false
    || !hashPattern.test(input.sourceSnapshotSha256) || source.snapshotSha256 !== input.sourceSnapshotSha256
    || populationValue.count !== tickers.length || populationValue.sha256 !== tickerHash) fail("capacity-snapshot-incomplete-or-expired");
  const publicationGrowthReserveBytes = storagePublicationGrowthReserve(input.publicationGrowth,
    { codeRevision: input.identity.codeRevision, tickerHash, schemaHash: input.sourceSchemaHash });
  const growth = storagePublicationGrowthSchema.parse(input.publicationGrowth);
  const { evidenceHash: publicationEvidenceHash, ...publicationUnsigned } = input.publications;
  if (await eodHash(publicationUnsigned) !== publicationEvidenceHash || input.publications.tickerHash !== tickerHash
    || await eodHash(input.publications.identity) !== await eodHash(input.identity)
    || input.publications.sessionDate !== growth.sourceSessionDate || input.publications.scopes.length !== 7
    || growth.sourcePublicationIds.some((id, index) => !input.publications.scopes.some((row) =>
      row.id === id && row.checksum === growth.sourcePublicationChecksums[index]))) fail("publication-growth-current-publications-mismatch");
  if (growth.sourceSnapshotSha256 !== input.sourceSnapshotSha256) fail("publication-growth-source-snapshot-mismatch");
  const growthAge = now.getTime() - Date.parse(growth.measuredAt);
  if (growthAge < 0 || growthAge > 86_400_000) fail("publication-growth-measurement-expired");
  const models = Array.isArray(report.retentionModels) ? report.retentionModels.map(object) : [];
  const projectedHistoryBytes = archive.withAdditionalCompleteRevisionAndTransientBytes;
  if (typeof projectedHistoryBytes !== "number" || !count(projectedHistoryBytes) || projectedHistoryBytes <= 0 || projectedHistoryBytes >= 350_000_000) fail("history-capacity-headroom-missing");
  const selected = [260, 90].map((hot) => models.find((model) => model.hotSessions === hot)).find((model) => {
    if (!model) return false;
    const database = object(model.database), physical = database.physicalBytes, headroom = model.sweepHeadroomSessions;
    return typeof headroom === "number" && count(headroom) && headroom >= 10 && model.sharedTickers === tickers.length
      && storageFallbackModelValid(report, model, tickers.length) && model.modeledSipRows === tickers.length * (Number(model.hotSessions) + headroom)
      && (model.fallbackStorage !== EOD_YAHOO_ARCHIVE_LAYOUT
        || Number(object(archive.fallbackReserve).sessions) >= 260 + growth.forecastSessions)
      && typeof physical === "number" && count(physical) && physical > 0
      && model.publicationGrowthReserveBytes === publicationGrowthReserveBytes
      && model.projectedBytes === physical + publicationGrowthReserveBytes && model.projectedBytes < 350_000_000;
  });
  if (!selected) fail("full-population-capacity-headroom-missing");
  const [liveTargetBytes, liveHistoryBytes] = await Promise.all([measureStorageLiveBytes(input.target), measureStorageLiveBytes(input.history)]);
  if (liveTargetBytes > Number(selected.projectedBytes) || liveHistoryBytes > projectedHistoryBytes) fail("live-capacity-exceeds-measured-projection");
  return { hotSessions: selected.hotSessions as 260 | 90, projectedMarketBytes: Number(selected.projectedBytes), projectedHistoryBytes,
    liveTargetBytes, liveHistoryBytes, publicationGrowthReserveBytes, forecastSessions: growth.forecastSessions,
    revisionsPerSession: growth.revisionsPerSession, analysisHash: await eodHash(report), measuredAt: now.toISOString() };
}
