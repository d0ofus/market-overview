import { z } from "zod";
import { eodHash } from "./eod-publication-service";
import { reviewedEodTickerAlias } from "./eod-ticker-aliases";
import type { Env } from "./types";
import { assessEodMembershipEvidence } from "./eod-membership-evidence";

const fail = (reason: string): never => { throw new Error(`eod-listing-evidence-${reason}`); };
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
});
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ticker = z.string().regex(/^[A-Z][A-Z0-9.-]{0,14}$/);
const normalized = (value: string) => value.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const EXCHANGE_HOSTS = new Set(["www.nasdaq.com", "nasdaq.com", "www.nasdaqtrader.com", "nasdaqtrader.com", "www.nyse.com", "nyse.com", "listingcenter.nasdaq.com"]);
/** Security-specific claims reviewed against primary documents. This is not a
 * parser that guesses which date in an announcement belongs to a ticker. */
const REVIEWED_LISTINGS: Record<string, { date: string; publishedDate: string; url: string; issuer: string; exchange: string; assetClass: string; statement: RegExp }> = {
  BRTM: { date: "2026-09-10", publishedDate:"2026-09-08", url: "https://www.sec.gov/Archives/edgar/data/2131350/000119312526385209/d102609dex991.htm",
    issuer: "B&R Technology Merger Corp.", exchange: "NASDAQ", assetClass: "equity",
    statement: /separate trading of its class a ordinary shares and warrants[,\s]+commencing september 10, 2026/i },
  GOLS: { date: "2026-01-02", publishedDate:"2026-01-02", url: "https://gabelli.com/research/gabelli-introduces-gols-a-new-way-to-access-the-global-sports-economy/",
    issuer: "Gabelli Opportunities in Live", exchange: "NYSE Arca", assetClass: "etf", statement: /now trading/i },
};

/** Issuer hosts are deliberately registered in code, not accepted as CLI proof. */
export function assertListingSourceUrl(value: string, symbol?: string): void {
  let url: URL;
  try { url = new URL(value); } catch { return fail("source-url-invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
    || !(EXCHANGE_HOSTS.has(url.hostname)
      || (url.hostname === "www.sec.gov" && /^\/Archives\/edgar\/data\/\d+\/\d+\/[^/]+\.htm$/.test(url.pathname))
      || (symbol === "GOLS" && url.hostname === "gabelli.com"))) fail("source-not-official");
}

export const listingEvidenceImportSchema = z.object({
  version: z.literal(1), event: z.literal("initial-listing"),
  security: z.object({ ticker, issuerName: z.string().min(3).max(200), exchange: z.enum(["NASDAQ", "NYSE", "NYSE American", "NYSE Arca"]),
    assetClass: z.enum(["equity", "etf"]), priorSymbols: z.array(ticker).max(0),
    issuerCik: z.string().regex(/^\d{1,10}$/).optional() }).strict(),
  listingDate: date, sourcePublishedDate: date, effectiveFromSession: date,
  sourceUrl: z.string().url().max(1_000), sourceDateText: z.string().min(8).max(40),
  sourcePublishedDateText: z.string().min(8).max(40), sourceQuote: z.string().min(30).max(3_000),
  supersedesHash: hash.nullable(),
}).strict();
export type ListingEvidenceImport = z.infer<typeof listingEvidenceImportSchema>;
const identityMembershipSchema=z.object({universeId:z.literal("nasdaq-core"),versionId:z.string().min(1).max(200),
  sourceType:z.literal("public-common-stock-proxy"),sourceUrl:z.literal("https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt"),
  sourceAsOfDate:date,verifiedAt:z.string().min(19).max(35),sourceTicker:z.literal("BRTM")}).strict();
export type ListingIdentityMembership=z.infer<typeof identityMembershipSchema>;
export const listingEvidenceRecordSchema = listingEvidenceImportSchema.extend({
  contentHash: hash, registeredAt: z.string().datetime(), codeRevision: z.string().regex(/^[a-f0-9]{40}$/),
  evidenceHash: hash,
  identityMembership:identityMembershipSchema.optional(),
}).strict();
export type ListingEvidenceRecord = z.infer<typeof listingEvidenceRecordSchema>;
const frozenListingReferenceSchema = z.object({ ticker, listingDate: date, effectiveFromSession: date, evidenceHash: hash }).strict();
export const frozenListingEvidenceSchema = z.object({
  version: z.literal(1), entries: z.array(frozenListingReferenceSchema).min(1).max(400), evidenceHash: hash,
}).strict();
export type FrozenListingEvidence = z.infer<typeof frozenListingEvidenceSchema>;
export const LISTING_EVIDENCE_REGISTRY = "eod-listing-registry:v1";
export const listingEvidenceKey = (value: string) => `eod-listing:${value}`;
const registrySchema = z.object({ version: z.literal(1), entries: z.array(listingEvidenceRecordSchema).max(400) }).strict();
function applicableVersions(entries: ListingEvidenceRecord[]): ListingEvidenceRecord[] {
  const superseded = new Set(entries.flatMap((entry) => entry.supersedesHash ? [entry.supersedesHash] : []));
  const current = entries.filter((entry) => !superseded.has(entry.evidenceHash));
  if (new Set(current.map((entry) => entry.security.ticker)).size !== current.length) fail("registry-version-conflict");
  return current;
}

function sourceDate(value: string): string | null {
  if (date.safeParse(value).success) return value;
  const match = /^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})$/.exec(value);
  if (!match) return null;
  const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].indexOf(match[1]!) + 1;
  const valueDate = `${match[3]}-${String(month).padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
  return date.safeParse(valueDate).success ? valueDate : null;
}

export function validateListingStatement(input: ListingEvidenceImport): void {
  assertListingSourceUrl(input.sourceUrl, input.security.ticker);
  const claim = REVIEWED_LISTINGS[input.security.ticker];
  if (!claim || input.sourceUrl !== claim.url || input.listingDate !== claim.date || input.sourcePublishedDate !== claim.publishedDate
    || !normalized(input.security.issuerName).startsWith(normalized(claim.issuer))
    || input.security.exchange !== claim.exchange || input.security.assetClass !== claim.assetClass
    || !claim.statement.test(input.sourceQuote)) fail("unreviewed-security-claim");
  const url = new URL(input.sourceUrl);
  if (url.hostname === "www.sec.gov" && (!input.security.issuerCik
    || Number(url.pathname.split("/")[4]) !== Number(input.security.issuerCik))) fail("source-issuer-mismatch");
  if (url.hostname === "gabelli.com" && !normalized(input.security.issuerName).startsWith("gabelliopportunitiesinlive")) fail("source-issuer-mismatch");
  if (sourceDate(input.sourceDateText) !== input.listingDate || sourceDate(input.sourcePublishedDateText) !== input.sourcePublishedDate
    || !input.sourceQuote.includes(input.sourceDateText)
    || !normalized(input.sourceQuote).includes(normalized(input.security.issuerName))
    || !new RegExp(`\\b${input.security.ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(input.sourceQuote)
    || !/initial public offering|initial listing|first (?:day of )?trading|commenc(?:e|ing) trading|begin trading|separate trading|launch(?:ed|es|ing)?|now trading/i.test(input.sourceQuote)
    || /formerly|ticker change|symbol change|transfer|uplisting|reverse merger|de.?spac/i.test(input.sourceQuote)
    || reviewedEodTickerAlias(input.security.ticker, input.listingDate)) fail("statement-identity-invalid");
}

export function listingDocumentText(value: string): string {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&")
    .replace(/&quot;|&#34;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
}

export async function verifyListingRecord(value: unknown, targetSession: string): Promise<ListingEvidenceRecord> {
  const parsed = listingEvidenceRecordSchema.safeParse(value);
  if (!parsed.success) return fail("record-invalid");
  const record = parsed.data;
  validateListingStatement(record);
  if(record.identityMembership && (record.security.ticker!=="BRTM" || record.identityMembership.sourceAsOfDate<record.listingDate
    || record.identityMembership.sourceAsOfDate>record.effectiveFromSession)) fail("record-membership-mismatch");
  const { evidenceHash, ...unsigned } = record;
  const knowledgeDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(record.registeredAt));
  if (!date.safeParse(targetSession).success || record.listingDate > targetSession || record.effectiveFromSession > targetSession
    || record.effectiveFromSession < knowledgeDate || record.listingDate > record.effectiveFromSession
    || record.sourcePublishedDate > record.registeredAt.slice(0, 10)
    || Date.parse(record.registeredAt) > Date.now() || await eodHash(unsigned) !== evidenceHash) fail("record-integrity");
  return record;
}

export async function validateFrozenListingEvidence(value: unknown, tickers: readonly string[], targetSession: string,
  ops?: D1Database): Promise<FrozenListingEvidence> {
  const parsed = frozenListingEvidenceSchema.safeParse(value);
  if (!parsed.success) return fail("frozen-invalid");
  const snapshot = parsed.data;
  const symbols = snapshot.entries.map((entry) => entry.ticker);
  if (new Set(symbols).size !== symbols.length || symbols.some((symbol) => !tickers.includes(symbol))
    || JSON.stringify(symbols) !== JSON.stringify([...symbols].sort())
    || await eodHash({ version: 1, entries: snapshot.entries }) !== snapshot.evidenceHash) fail("frozen-integrity");
  for (const entry of snapshot.entries) {
    if (entry.listingDate > targetSession || entry.effectiveFromSession > targetSession) fail("frozen-session-invalid");
    if (ops) {
      const stored = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
        .bind(listingEvidenceKey(entry.evidenceHash)).first<string>("evidence_json");
      if (!stored) fail("immutable-record-missing");
      const record = await verifyListingRecord(JSON.parse(stored!),targetSession);
      if (record.evidenceHash !== entry.evidenceHash || record.security.ticker !== entry.ticker
        || record.listingDate !== entry.listingDate || record.effectiveFromSession !== entry.effectiveFromSession) fail("immutable-record-mismatch");
    }
  }
  return snapshot;
}

export async function loadFrozenListingEvidence(env: Pick<Env, "OPS_DB">, tickers: readonly string[], targetSession: string,
  calendar?: readonly string[]): Promise<FrozenListingEvidence | undefined> {
  if (!env.OPS_DB) return undefined;
  const raw = await env.OPS_DB.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
    .bind(LISTING_EVIDENCE_REGISTRY).first<string>("evidence_json");
  if (!raw) return undefined;
  const registry = registrySchema.safeParse(JSON.parse(raw));
  if (!registry.success) return fail("registry-invalid");
  const yearAnchor = calendar?.filter((date) => date.slice(0,4) < targetSession.slice(0,4)).at(-1);
  const earliestNeeded = calendar?.at(-252) && yearAnchor ? [calendar.at(-252)!,yearAnchor].sort()[0]!
    : `${Number(targetSession.slice(0,4))-2}-01-01`;
  const entries = applicableVersions(registry.data.entries.filter((entry) => entry.effectiveFromSession <= targetSession))
    .filter((entry) => tickers.includes(entry.security.ticker) && entry.listingDate > earliestNeeded)
    .sort((a, b) => a.security.ticker.localeCompare(b.security.ticker))
    .map((entry) => ({ticker:entry.security.ticker,listingDate:entry.listingDate,effectiveFromSession:entry.effectiveFromSession,evidenceHash:entry.evidenceHash}));
  if (!entries.length) return undefined;
  const unsigned = { version: 1 as const, entries };
  return validateFrozenListingEvidence({ ...unsigned, evidenceHash: await eodHash(unsigned) }, tickers, targetSession, env.OPS_DB);
}

export function listingDateFor(snapshot: FrozenListingEvidence | undefined, symbol: string): string | undefined {
  return snapshot?.entries.find((entry) => entry.ticker === symbol)?.listingDate;
}

/** A missing Core row is not fabricated. The reviewed SEC common-share claim
 * supplies identity, corroborated by an actual dated Nasdaq membership row. */
export function observeBrtmListingIdentity(input:ListingEvidenceImport,document:string,membership:unknown,calendarDates:string[]) {
  validateListingStatement(input);
  const parsed=identityMembershipSchema.safeParse(membership);
  const text=listingDocumentText(document).replace(/&#(?:x[0-9a-f]+|\d+);/gi,"");
  if(input.security.ticker!=="BRTM" || !parsed.success
    || !assessEodMembershipEvidence(parsed.data,input.effectiveFromSession,calendarDates).publishable
    || parsed.data.sourceAsOfDate<input.listingDate
    || !normalized(text).includes(normalized(listingDocumentText(input.sourceQuote).replace(/&#(?:x[0-9a-f]+|\d+);/gi,"")))
    || !normalized(text).includes(normalized("The Class A ordinary shares and warrants that are separated will trade on the Nasdaq Stock Market under the symbols BRTM and BRTMW, respectively"))) fail("nasdaq-sec-identity-unverified");
  const issuer=/B&R Technology Merger Corp\./i.exec(text)?.[0];
  if(!issuer)fail("nasdaq-sec-identity-unverified");
  return {ticker:"BRTM",issuerName:issuer!,exchange:"NASDAQ",assetClass:"equity",membership:parsed.data};
}

/** Post-cutover UI-only descendants may run the identical approved operator.
 * Runtime, workflow and dependency changes always require their own approval. */
export function validateListingOperatorRevision(input:{actualRevision:string;approvedRevision:string;remoteMainRevision:string;
  production:boolean;isAncestor:boolean;changedFiles:string[]}):void {
  if (![input.actualRevision,input.approvedRevision,input.remoteMainRevision].every(value=>/^[a-f0-9]{40}$/.test(value))
    || input.actualRevision!==input.remoteMainRevision) fail("github-main-mismatch");
  if (input.actualRevision===input.approvedRevision) return;
  if (!input.production || !input.isAncestor || input.changedFiles.length===0 || input.changedFiles.some(path=>
    (!path.startsWith("web/") && !path.startsWith("docs/") && !/^[A-Za-z0-9_-]+\.md$/.test(path))
    || /(?:^|\/)(?:package(?:-lock)?\.json|\.npmrc)$/.test(path))) fail("unapproved-operator-code");
}

/** Explicit operator registration. Downloaded bytes and observed identity are
 * supplied by the pinned CLI, never accepted through a public endpoint. */
export async function registerListingEvidence(ops: D1Database, input: unknown, document: string,
  observed: { ticker: string; issuerName: string; exchange: string; assetClass: string; firstRetainedDate: string | null; membership?:ListingIdentityMembership },
  codeRevision: string, now = new Date(), reconstruction?: { deadlineAt: string; nextAttemptAt: string }):
  Promise<{ evidenceHash: string; requiresReconstruction: boolean; unchanged: boolean; queuedRunId?: string }> {
  const parsed = listingEvidenceImportSchema.safeParse(input);
  if (!parsed.success) return fail("import-invalid");
  const candidate = parsed.data;
  if (reconstruction && [reconstruction.deadlineAt,reconstruction.nextAttemptAt].some((value) => !z.string().datetime().safeParse(value).success)) fail("reconstruction-time-invalid");
  validateListingStatement(candidate);
  if (new TextEncoder().encode(document).byteLength > 2_000_000
    || !listingDocumentText(document).includes(listingDocumentText(candidate.sourceQuote))
    || !listingDocumentText(document).includes(candidate.sourcePublishedDateText)) fail("document-quote-missing");
  if (candidate.security.ticker !== observed.ticker || !normalized(observed.issuerName).startsWith(normalized(candidate.security.issuerName))
    || candidate.security.exchange !== observed.exchange || candidate.security.assetClass !== observed.assetClass
    || (observed.firstRetainedDate !== null && observed.firstRetainedDate < candidate.listingDate)) fail("observed-identity-contradiction");
  const previousJson = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
    .bind(LISTING_EVIDENCE_REGISTRY).first<string>("evidence_json");
  const prior = previousJson ? registrySchema.parse(JSON.parse(previousJson)) : { version: 1 as const, entries: [] };
  const existing = applicableVersions(prior.entries).find((entry) => entry.security.ticker === candidate.security.ticker);
  const contentHash = await eodHash(document);
  let reused: ListingEvidenceRecord | undefined;
  if (existing) {
    const { evidenceHash: _hash, registeredAt: _at, codeRevision: _revision, contentHash: _content, identityMembership:_membership, ...oldInput } = existing;
    if (await eodHash(oldInput) === await eodHash(candidate)) {
      await verifyListingRecord(existing, existing.effectiveFromSession);
      if (!reconstruction) return {evidenceHash:existing.evidenceHash,requiresReconstruction:true,unchanged:true};
      const priorRun=await ops.prepare("SELECT input_json FROM eod_runs WHERE id=?")
        .bind(`eod:active:${candidate.effectiveFromSession}:reconcile`).first<string>("input_json");
      if (priorRun) {
        const frozen=JSON.parse(priorRun) as {listingEvidence?:unknown};
        if (frozen.listingEvidence) {
          const snapshot=frozenListingEvidenceSchema.safeParse(frozen.listingEvidence);
          if (snapshot.success && snapshot.data.entries.some((entry)=>entry.evidenceHash===existing.evidenceHash)) {
            return {evidenceHash:existing.evidenceHash,requiresReconstruction:false,unchanged:true,queuedRunId:`eod:active:${candidate.effectiveFromSession}:reconcile`};
          }
        }
      }
      reused = existing;
    }
  }
  if (!reused && (existing?.evidenceHash ?? null) !== candidate.supersedesHash) fail("superseded-version-mismatch");
  if (existing && candidate.effectiveFromSession < existing.effectiveFromSession) fail("effective-session-regression");
  const unsigned = { ...candidate, contentHash, registeredAt: now.toISOString(), codeRevision,
    ...(observed.membership ? {identityMembership:observed.membership} : {}) };
  const record = reused ?? await verifyListingRecord({ ...unsigned, evidenceHash: await eodHash(unsigned) }, candidate.effectiveFromSession);
  const next = registrySchema.parse({ version: 1, entries: reused ? prior.entries : [...prior.entries, record] });
  const evidenceId = listingEvidenceKey(record.evidenceHash), recordJson = JSON.stringify(record), nextJson = JSON.stringify(next);
  if (new TextEncoder().encode(nextJson).byteLength > 1_800_000) fail("registry-capacity-exceeded");
  const queuedRunId = `eod:active:${candidate.effectiveFromSession}:reconcile`;
  const results = await ops.batch([
    ops.prepare(`SELECT json(CASE WHEN NOT EXISTS(SELECT 1 FROM eod_runs WHERE session_date>=? AND status<>'completed'
      AND (status IN ('running','dispatching','dispatched') OR dispatch_token IS NOT NULL OR lease_token IS NOT NULL
        OR input_json<>'{}')) THEN 'true' ELSE 'listing affected run busy' END)`).bind(candidate.effectiveFromSession),
    ops.prepare(`SELECT json(CASE WHEN ?=1 OR NOT EXISTS(SELECT 1 FROM eod_runs WHERE session_date>=? AND status='completed')
      THEN 'true' ELSE 'listing reconstruction required' END)`).bind(reconstruction ? 1 : 0,candidate.effectiveFromSession),
    ops.prepare(`SELECT json(CASE WHEN COALESCE((SELECT evidence_json FROM eod_rollout_evidence WHERE id=?),'')=?
      THEN 'true' ELSE 'listing registry changed' END)`).bind(LISTING_EVIDENCE_REGISTRY, previousJson ?? ""),
    ops.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING")
      .bind(evidenceId, recordJson, now.toISOString()),
    ops.prepare(`SELECT json(CASE WHEN (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=?
      THEN 'true' ELSE 'listing immutable conflict' END)`).bind(evidenceId, recordJson),
    ops.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json,updated_at=excluded.updated_at RETURNING id`)
      .bind(LISTING_EVIDENCE_REGISTRY, nextJson, now.toISOString()),
    ...(reconstruction ? [ops.prepare(`INSERT INTO eod_runs(id,session_date,purpose,mode,status,stage,input_json,progress_json,created_at,updated_at,deadline_at,next_attempt_at)
      VALUES(?,?,'reconcile','active','queued','queued','{}','{}',?,?,?,?) ON CONFLICT(session_date,purpose,mode) DO UPDATE SET
      status='queued',stage='queued',input_json='{}',progress_json='{}',completed_at=NULL,error_code=NULL,error_message=NULL,
      next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at WHERE eod_runs.status='completed' RETURNING id`)
      .bind(queuedRunId,candidate.effectiveFromSession,now.toISOString(),now.toISOString(),reconstruction.deadlineAt,reconstruction.nextAttemptAt)] : []),
  ]);
  if (results[5]?.results.length !== 1) fail("registry-ownership-lost");
  const stored = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(evidenceId).first<string>("evidence_json");
  if (stored !== recordJson) fail("immutable-record-conflict");
  return { evidenceHash: record.evidenceHash, requiresReconstruction: !reconstruction, unchanged: Boolean(reused),
    ...(reconstruction ? {queuedRunId} : {}) };
}
