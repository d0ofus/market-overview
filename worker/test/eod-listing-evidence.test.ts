import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { listingEvidenceImportSchema, registerListingEvidence, loadFrozenListingEvidence, validateFrozenListingEvidence,
  validateListingStatement, validateListingOperatorRevision, observeBrtmListingIdentity, LISTING_EVIDENCE_REGISTRY } from "../src/eod-listing-evidence";
import { listingFixture } from "./helpers/eod-listing-fixtures";
import { computeEodBreadthMetrics, computeEodTickerMetrics, type EodMetricBar } from "../src/eod-metrics";
import { validateListingBreadthCoverage } from "../src/market-storage-acceptance";

const now = new Date("2026-09-11T15:00:00Z");
const observed = { ticker: "BRTM", issuerName: "B&R Technology Merger Corp.", exchange: "NASDAQ", assetClass: "equity", firstRetainedDate: null };
const code = "b".repeat(40);
const databases: ReturnType<typeof createSqliteD1>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.dispose()));
function database() { const db = createSqliteD1(); databases.push(db); db.migrate("ops-migrations"); return db; }

describe("explicit listing evidence, without inferring provider history age", () => {
  it("registers atomically/idempotently and preserves older-session input shape and immutable superseded records", async () => {
    const ops = database(), candidate = listingFixture();
    const first = await registerListingEvidence(ops.db, candidate, candidate.sourceQuote, observed, code, now);
    const stored = (await ops.db.prepare("SELECT * FROM eod_rollout_evidence ORDER BY id").all()).results;
    expect(await registerListingEvidence(ops.db, candidate, candidate.sourceQuote, observed, code, new Date(now.getTime()+1000)))
      .toEqual({ ...first, unchanged: true });
    expect((await ops.db.prepare("SELECT * FROM eod_rollout_evidence ORDER BY id").all()).results).toEqual(stored);
    expect(await loadFrozenListingEvidence({ OPS_DB: ops.db }, ["BRTM"], "2026-09-10")).toBeUndefined();
    const frozen = (await loadFrozenListingEvidence({ OPS_DB: ops.db }, ["BRTM"], "2026-09-11"))!;
    expect(frozen.entries[0]?.listingDate).toBe("2026-09-10");
    const correction = { ...candidate, supersedesHash: first.evidenceHash, effectiveFromSession: "2026-09-12" };
    const corrected=await registerListingEvidence(ops.db, correction, correction.sourceQuote, observed, code, now);
    expect(await validateFrozenListingEvidence(frozen, ["BRTM"], "2026-09-11", ops.db)).toEqual(frozen);
    expect(await loadFrozenListingEvidence({OPS_DB:ops.db},["BRTM"],"2026-09-11")).toEqual(frozen);
    expect((await ops.db.prepare("SELECT id FROM eod_rollout_evidence").all()).results).toHaveLength(3);
    await expect(registerListingEvidence(ops.db,{...candidate,supersedesHash:correction.supersedesHash},candidate.sourceQuote,observed,code,now)).rejects.toThrow("superseded-version-mismatch");
    await expect(registerListingEvidence(ops.db,{...candidate,supersedesHash:corrected.evidenceHash},candidate.sourceQuote,observed,code,now)).rejects.toThrow("effective-session-regression");
  });

  it("allows only an approved production runtime's unchanged operator on a clean pushed UI-only descendant",()=>{
    const input={actualRevision:"d".repeat(40),approvedRevision:"c".repeat(40),remoteMainRevision:"d".repeat(40),production:true,isAncestor:true,changedFiles:["web/components/admin/eod-status.tsx","docs/operator.md"]};
    expect(()=>validateListingOperatorRevision(input)).not.toThrow();
    for(const path of ["worker/src/eod-listing-evidence.ts","scripts/root.ts","package-lock.json","web/package.json",".github/workflows/eod-market-data.yml"]) {
      expect(()=>validateListingOperatorRevision({...input,changedFiles:[path]})).toThrow("unapproved-operator-code");
    }
    expect(()=>validateListingOperatorRevision({...input,production:false})).toThrow("unapproved-operator-code");
    expect(()=>validateListingOperatorRevision({...input,isAncestor:false})).toThrow("unapproved-operator-code");
  });

  it("observes missing-Core BRTM identity only from the exact SEC common-share mapping and a dated official Nasdaq member",async()=>{
    const candidate=listingFixture();
    const document=candidate.sourceQuote+" The Class A ordinary shares and warrants that are separated will trade on the Nasdaq Stock Market under the symbols &#8220;BRTM&#8221; and &#8220;BRTMW,&#8221; respectively.";
    const membership={universeId:"nasdaq-core" as const,versionId:"uv-fixture",sourceType:"public-common-stock-proxy" as const,
      sourceUrl:"https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt" as const,sourceAsOfDate:"2026-09-11",verifiedAt:"2026-09-11 09:39:04",sourceTicker:"BRTM" as const};
    const calendar=["2026-09-03","2026-09-04","2026-09-08","2026-09-09","2026-09-10","2026-09-11"];
    const identity=observeBrtmListingIdentity(candidate,document,membership,calendar);
    expect(identity).toMatchObject({ticker:"BRTM",issuerName:"B&R Technology Merger Corp.",exchange:"NASDAQ",assetClass:"equity",membership});
    for(const changed of [{sourceTicker:"BRTMU"},{sourceAsOfDate:"2026-09-12"},{sourceUrl:"https://unrelated.example/list"},{universeId:"nyse-core"}]) {
      expect(()=>observeBrtmListingIdentity(candidate,document,{...membership,...changed},calendar)).toThrow("nasdaq-sec-identity-unverified");
    }
    expect(()=>observeBrtmListingIdentity(candidate,candidate.sourceQuote,membership,calendar)).toThrow("nasdaq-sec-identity-unverified");
    const ops=database();
    await registerListingEvidence(ops.db,candidate,document,{...identity,firstRetainedDate:"2026-09-10"},code,now);
    const raw=await ops.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(LISTING_EVIDENCE_REGISTRY).first<string>("evidence_json");
    expect(JSON.parse(raw!).entries[0].identityMembership).toEqual(membership);
  });

  it.each([
    { listingDate: "2026-02-30" }, { effectiveFromSession: "2026-09-10" }, { sourcePublishedDate: "2026-09-12" },
    { sourceUrl: "https://attacker.example/ipo" }, { sourceUrl: "https://www.nasdaq.com@127.0.0.1/ipo" },
    { sourceQuote: "B&R Technology Merger Corp. formerly OLD will begin trading IPO on September 10, 2026." },
    { sourceDateText: "September 9, 2026" }, { security: { ...listingFixture().security, priorSymbols: ["OLD"] } },
  ])("rejects invalid or misleading evidence before mutation (%j)", async (change) => {
    const ops = database(), candidate = { ...listingFixture(), ...change };
    await expect(registerListingEvidence(ops.db, candidate, candidate.sourceQuote, observed, code, now)).rejects.toThrow();
    expect((await ops.db.prepare("SELECT id FROM eod_rollout_evidence").all()).results).toEqual([]);
  });

  it("rejects renamed securities, issuer mismatch, earlier retained prices and raw imported JSON without document evidence", async () => {
    const ops = database(), candidate = listingFixture();
    await expect(registerListingEvidence(ops.db, candidate, candidate.sourceQuote, { ...observed, firstRetainedDate: "2026-08-01" }, code, now)).rejects.toThrow("observed-identity-contradiction");
    await expect(registerListingEvidence(ops.db, candidate, candidate.sourceQuote, { ...observed, issuerName: "Unrelated Issuer" }, code, now)).rejects.toThrow("observed-identity-contradiction");
    await expect(registerListingEvidence(ops.db, candidate, "{}", observed, code, now)).rejects.toThrow("document-quote-missing");
    for(const ticker of ["RSHO","WELD"]) expect(() => validateListingStatement({ ...candidate, security: { ...candidate.security, ticker },
      sourceQuote: candidate.sourceQuote.replace("BRTM", ticker) })).toThrow("unreviewed-security-claim");
    expect(() => validateListingStatement({...candidate,listingDate:"2026-07-21",sourceDateText:"July 21, 2026",
      sourceUrl:"https://www.sec.gov/Archives/edgar/data/2131350/000119312526312808/d158424dex992.htm",
      sourceQuote:"B&R Technology Merger Corp. announced its initial public offering. The units began trading as BRTMU on July 21, 2026. The common shares BRTM will separately trade later."})).toThrow("unreviewed-security-claim");
    expect(listingEvidenceImportSchema.safeParse({ ...candidate, firstTradeDate: 123 }).success).toBe(false);
  });

  it("refuses changes to a running same-session frozen input, without touching that run or registry", async () => {
    const ops = database(), candidate = listingFixture();
    ops.script("INSERT INTO eod_runs(id,session_date,purpose,mode,status,stage,input_json,created_at,updated_at) VALUES('busy','2026-09-11','daily','active','running','prices','{\"frozen\":true}','x','x')");
    const before = (await ops.db.prepare("SELECT * FROM eod_runs").all()).results;
    await expect(registerListingEvidence(ops.db, candidate, candidate.sourceQuote, observed, code, now)).rejects.toThrow();
    expect((await ops.db.prepare("SELECT * FROM eod_runs").all()).results).toEqual(before);
    expect((await ops.db.prepare("SELECT id FROM eod_rollout_evidence").all()).results).toEqual([]);
  });

  it("keeps unknown histories missing and independently validates each scope's structural exclusions", async () => {
    const ops = database(), candidate = { ...listingFixture(), effectiveFromSession: "2026-09-10", sourceDateText: "September 10, 2026",
      sourceQuote: listingFixture().sourceQuote };
    await registerListingEvidence(ops.db, candidate, candidate.sourceQuote, observed, code, new Date("2026-09-10T21:00:00Z"));
    const evidence = (await loadFrozenListingEvidence({ OPS_DB: ops.db }, ["BRTM","OLD","UNKNOWN"], "2026-09-10"))!;
    const calendar = Array.from({ length: 260 }, (_, i) => new Date(Date.parse("2026-09-10T00:00:00Z") - (259-i)*86_400_000).toISOString().slice(0,10));
    const bar = (ticker:string, sessionDate:string):EodMetricBar => ({ticker,sessionDate,close:100,high:101,low:99,open:100,reportedVolume:100,sourceProvider:"alpaca",priceBasis:"split"});
    const features = new Map([
      ["OLD", computeEodTickerMetrics({ticker:"OLD",targetSession:"2026-09-10",calendarDates:calendar,bars:calendar.map(date=>bar("OLD",date)),explainHistory:true})],
      ["BRTM", computeEodTickerMetrics({ticker:"BRTM",targetSession:"2026-09-10",calendarDates:calendar,bars:[bar("BRTM","2026-09-10")],verifiedListingDate:"2026-09-10",explainHistory:true})],
      ["UNKNOWN", computeEodTickerMetrics({ticker:"UNKNOWN",targetSession:"2026-09-10",calendarDates:calendar,bars:[],explainHistory:true})],
    ]);
    expect(features.get("BRTM")).toMatchObject({price:100,change1d:null,sma200:null,fieldReasons:{change1d:"verified-recent-listing",sma200:"verified-recent-listing"}});
    expect(features.get("UNKNOWN")?.fieldReasons?.sma200).toBe("missing-required-session");
    const members=[{ticker:"OLD"},{ticker:"BRTM",verifiedListingDate:"2026-09-10"}];
    const result=computeEodBreadthMetrics({universeId:"nasdaq-core",targetSession:"2026-09-10",calendarDates:calendar,members,bars:[],features});
    expect(result.publishable).toBe(true);
    expect(result.metrics.metricCoverage.advancers).toMatchObject({eligiblePopulation:1,structurallyIneligibleCount:1,coveragePct:100});
    const input={universe:"nasdaq-core",members:["OLD","BRTM"],calendar,evidence,metrics:result.metrics,provenance:{listingEvidenceHash:evidence.evidenceHash}};
    expect(()=>validateListingBreadthCoverage(input)).not.toThrow();
    const altered=structuredClone(input);altered.metrics.metricCoverage.pctAbove200MA!.eligiblePopulation=2;
    expect(()=>validateListingBreadthCoverage(altered)).toThrow("denominator-invalid");
    const short=structuredClone(input);short.metrics.metricCoverage.pctAbove5MA!.structurallyIneligibleCount=0;
    expect(()=>validateListingBreadthCoverage(short)).toThrow("denominator-invalid");
    const unknown=computeEodBreadthMetrics({universeId:"nasdaq-core",targetSession:"2026-09-10",calendarDates:calendar,members:[...members,{ticker:"UNKNOWN"}],bars:[],features});
    expect(unknown.publishable).toBe(false);
    expect(unknown.metrics.metricCoverage.pctAbove200MA).toMatchObject({eligiblePopulation:2,missingCount:1,status:"suppressed"});
    expect(()=>computeEodTickerMetrics({ticker:"BRTM",targetSession:"2026-09-10",calendarDates:calendar,bars:[bar("BRTM","2026-09-09")],verifiedListingDate:"2026-09-10",explainHistory:true})).toThrow("history-contradiction");
    await ops.db.prepare("DELETE FROM eod_rollout_evidence WHERE id<>?").bind(LISTING_EVIDENCE_REGISTRY).run();
    await expect(validateFrozenListingEvidence(evidence,["BRTM","OLD","UNKNOWN"],"2026-09-10",ops.db)).rejects.toThrow("immutable-record-missing");
  });

  it("atomically queues fresh-input same-session reconstruction and keeps prior publications/runs separate",async()=>{
    const ops=database(),candidate=listingFixture();
    ops.script("INSERT INTO eod_runs(id,session_date,purpose,mode,status,stage,input_json,created_at,updated_at) VALUES('old','2026-09-11','daily','active','completed','finished','{\"old\":true}','x','x')");
    await expect(registerListingEvidence(ops.db,candidate,candidate.sourceQuote,observed,code,now)).rejects.toThrow();
    expect((await ops.db.prepare("SELECT id FROM eod_rollout_evidence").all()).results).toEqual([]);
    const schedule={deadlineAt:"2026-09-11T22:00:00Z",nextAttemptAt:"2026-09-11T20:20:00Z"};
    const result=await registerListingEvidence(ops.db,candidate,candidate.sourceQuote,observed,code,now,schedule);
    expect(result).toMatchObject({requiresReconstruction:false,queuedRunId:"eod:active:2026-09-11:reconcile"});
    expect(await ops.db.prepare("SELECT status,input_json FROM eod_runs WHERE id=?").bind(result.queuedRunId!).first()).toEqual({status:"queued",input_json:"{}"});
    expect(await ops.db.prepare("SELECT status,input_json FROM eod_runs WHERE id='old'").first()).toEqual({status:"completed",input_json:'{"old":true}'});
    expect(await registerListingEvidence(ops.db,candidate,candidate.sourceQuote,observed,code,now,schedule)).toEqual({...result,unchanged:true});
  });
});
