import { Hono } from "hono";
import { isAdminRequestAuthorized } from "./auth";
import { getMarketDataDb } from "./market-data-db";
import { getOpsDb } from "./ops-db";
import { parseLocalTime, zonedParts } from "./refresh-timing";
import { ensureMarketCalendarCoverage } from "./market-calendar-cache";
import { eodEnqueueSchema } from "./validation";
import type { Env, EodHistorySelection, EodStoredHistorySelection, EodInputCorrectionStatus } from "./types";

export type EodPurpose = "daily" | "reconcile" | "backfill" | "maintenance";
export type EodRun = {
  id:string; session_date:string; purpose:EodPurpose; mode:"shadow"|"active"; status:string;
  stage:string; attempt:number; lease_until:string|null; next_attempt_at:string|null;
  deadline_at:string|null; deadline_missed:number; error_code:string|null; updated_at:string;
  input_json:string; progress_json:string;
  github_run_id?:string|null; dispatch_token?:string|null;
  dispatch_requested_at?:string|null; dispatch_checked_at?:string|null;
  deadline_checked_at?:string|null; deadline_missing_scopes_json?:string;
  error_message?:string|null; created_at?:string;
  history_tickers_json?:string|null; history_sessions?:520|1400;
  completed_input_clock?:number|null;
};

export const EOD_PUBLICATION_SCOPES = ["overview:default", "breadth:sp500-core", "breadth:nasdaq-core",
  "breadth:nyse-core", "breadth:russell2000-core", "breadth:overall-market-proxy"] as const;

function validSessionDate(date: string): boolean {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(ms)
    && new Date(ms).toISOString().slice(0, 10) === date;
}

export function eodEnabled(env: Env): boolean {
  return env.EOD_RUNNER_MODE === "shadow" || env.EOD_RUNNER_MODE === "active";
}

// Calendar times are local New York HH:mm, never UTC midnight masquerading as a session.
export function eodSlot(now: Date, session: {sessionDate:string;closeAt:string}): "first"|"retry"|"last"|"deadline"|null {
  const local = zonedParts(now,"America/New_York");
  if (local.localDate !== session.sessionDate) return null;
  const close = parseLocalTime(session.closeAt);
  if (!close) throw new Error("Invalid exchange close time.");
  const elapsed = local.minutesOfDay-close.hour*60-close.minute;
  if (elapsed >= 120) return "deadline";
  if (elapsed >= 95) return "last";
  if (elapsed >= 50) return "retry";
  return elapsed >= 20 ? "first" : null;
}

export function eodDeadline(sessionDate:string,closeAt:string):string {
  const close = parseLocalTime(closeAt);
  if (!validSessionDate(sessionDate) || !close) throw new Error("Invalid exchange session or close time.");
  const wall=Date.parse(`${sessionDate}T00:00:00Z`)+(close.hour*60+close.minute+120)*60_000;
  // Offset is evaluated on the session, so DST and early closes both apply.
  const probe=new Date(`${sessionDate}T18:00:00Z`);
  const local=zonedParts(probe,"America/New_York");
  return new Date(wall+(18*60-local.minutesOfDay)*60_000).toISOString();
}

export async function expectedEodSession(env:Env,now=new Date()):Promise<string|null> {
  const local=zonedParts(now,"America/New_York");
  const time=`${Math.floor(local.minutesOfDay/60)}`.padStart(2,"0")+":"+`${local.minutesOfDay%60}`.padStart(2,"0");
  const row=await getMarketDataDb(env).prepare(`SELECT session_date as date FROM market_calendar_sessions
    WHERE (session_date<? OR (session_date=? AND close_at<=?))
      AND EXISTS (SELECT 1 FROM market_calendar_refresh_state WHERE id='default' AND covered_start<=? AND covered_end>=?)
    ORDER BY session_date DESC LIMIT 1`)
    .bind(local.localDate,local.localDate,time,local.localDate,local.localDate).first<{date:string}>();
  return row?.date ?? null;
}

export class EodHistoryRequestBusyError extends Error {
  constructor() {
    super("The saved history request cannot change while its runner or GitHub dispatch may still be active.");
    this.name = "EodHistoryRequestBusyError";
  }
}

export function eodRunHistorySelection(run: Pick<EodRun, "history_tickers_json" | "history_sessions">): EodStoredHistorySelection {
  return { historyTickers: run.history_tickers_json ? JSON.parse(run.history_tickers_json) as string[] : null,
    historySessions: run.history_sessions ?? 520 };
}

export async function enqueueEodRun(env: Env, sessionDate: string, purpose:EodPurpose = "daily", now = new Date(),
  historySelection: EodHistorySelection = {}): Promise<EodRun> {
  if (!eodEnabled(env)) throw new Error("EOD runner is disabled.");
  if (!validSessionDate(sessionDate)) throw new Error("Invalid EOD session date.");
  // Validate direct coordinator callers as well as the HTTP boundary. No
  // supplied selection means resume, not reset a prior scoped/deep request.
  const request = eodEnqueueSchema.parse({ ...historySelection, sessionDate, purpose });
  const hasSelection = request.historyTickers !== undefined || request.historySessions !== undefined;
  const tickersJson = request.historyTickers ? JSON.stringify(request.historyTickers) : null;
  const historySessions = request.historySessions ?? 520;
  const session = await getMarketDataDb(env).prepare("SELECT close_at AS closeAt FROM market_calendar_sessions WHERE session_date=?")
    .bind(sessionDate).first<{ closeAt: string }>();
  if (!session) throw new Error("Unknown exchange session.");
  const deadline = eodDeadline(sessionDate, session.closeAt);
  const notBefore = new Date(Math.max(now.getTime(), Date.parse(deadline) - 100 * 60_000)).toISOString();
  const id = `eod:${env.EOD_RUNNER_MODE}:${sessionDate}:${purpose}`;
  const timestamp = now.toISOString();
  await getOpsDb(env).prepare(
    `INSERT INTO eod_runs(id,session_date,purpose,mode,status,stage,created_at,updated_at,deadline_at,next_attempt_at,
      history_tickers_json,history_sessions)
     VALUES(?,?,?,?,'queued','queued',?,?,?,?,?,?) ON CONFLICT(session_date,purpose,mode)
     DO UPDATE SET deadline_at=excluded.deadline_at WHERE eod_runs.deadline_at IS NULL`,
  ).bind(id,sessionDate,purpose,env.EOD_RUNNER_MODE,timestamp,timestamp,deadline,notBefore,tickersJson,historySessions).run();
  const run = await getOpsDb(env).prepare("SELECT * FROM eod_runs WHERE id=?").bind(id).first<EodRun>();
  if (!run) throw new Error("EOD run was not persisted.");
  if (hasSelection && ((run.history_tickers_json ?? null) !== tickersJson || (run.history_sessions ?? 520) !== historySessions)) {
    if (["running", "dispatched", "dispatching"].includes(run.status) || run.dispatch_token
      || (run.lease_until && run.lease_until > timestamp)) throw new EodHistoryRequestBusyError();
    // A retrying row can represent an accepted POST whose response timed out.
    // Check GitHub before changing its durable inputs; failure stays closed.
    if (run.dispatch_requested_at || run.github_run_id) {
      if (!env.EOD_GITHUB_TOKEN) throw new EodHistoryRequestBusyError();
      const repository = env.EOD_GITHUB_REPOSITORY ?? "d0ofus/market-overview";
      if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new EodHistoryRequestBusyError();
      try {
        if (await findActiveGithubRun(env, repository, env.EOD_GITHUB_WORKFLOW ?? "eod-market-data.yml", run)) {
          throw new EodHistoryRequestBusyError();
        }
      } catch { throw new EodHistoryRequestBusyError(); }
    }
    const changed = await getOpsDb(env).prepare(`UPDATE eod_runs SET history_tickers_json=?,history_sessions=?,
      status='queued',stage='queued',input_json='{}',progress_json='{}',completed_at=NULL,
      error_code=NULL,error_message=NULL,next_attempt_at=?,updated_at=?
      WHERE id=? AND status=? AND updated_at=? AND history_tickers_json IS ? AND history_sessions=?
      AND dispatch_token IS NULL AND (lease_until IS NULL OR lease_until<=?)`)
      .bind(tickersJson,historySessions,notBefore,timestamp,id,run.status,run.updated_at,
        run.history_tickers_json ?? null,run.history_sessions ?? 520,timestamp).run();
    if (!changed.meta.changes) throw new EodHistoryRequestBusyError();
    const updated = await getOpsDb(env).prepare("SELECT * FROM eod_runs WHERE id=?").bind(id).first<EodRun>();
    if (!updated) throw new Error("EOD history request disappeared.");
    return updated;
  }
  return run;
}

export async function requestEodRefresh(env: Env, sessionDate:string):Promise<EodRun> {
  const run=await enqueueEodRun(env,sessionDate,"reconcile");
  if (run.status==="completed") {
    const reset=await getOpsDb(env).prepare(`UPDATE eod_runs SET status='queued',input_json='{}',next_attempt_at=NULL,completed_at=NULL
      WHERE id=? AND status='completed' AND (lease_until IS NULL OR lease_until<=?)`).bind(run.id,new Date().toISOString()).run();
    if (reset.meta.changes) { run.status="queued"; run.next_attempt_at=null; }
  }
  await dispatchEodRun(env,run);
  return run;
}

type GithubRun = { id: number; status: string; display_title: string; head_branch: string; event: string };

async function githubRequest(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`https://api.github.com${path}`, { ...init, headers: {
    Authorization: `Bearer ${env.EOD_GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
    "User-Agent": "market-overview-eod", "Content-Type": "application/json", ...init.headers,
  }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`github-${init.method === "POST" ? "dispatch" : "run-check"}-http-${response.status}`);
  return response;
}

async function findActiveGithubRun(env: Env, repository: string, workflow: string, run: EodRun): Promise<GithubRun | null> {
  if (run.github_run_id && /^\d+$/.test(run.github_run_id)) {
    try {
      const response = await githubRequest(env, `/repos/${repository}/actions/runs/${run.github_run_id}`);
      const known = await response.json() as GithubRun;
      if (!known.status || !Number.isSafeInteger(known.id)) throw new Error("github-run-check-invalid-payload");
      if (known.status !== "completed") return known;
    } catch (error) {
      // A retained local run may outlive GitHub's run retention. Missing IDs
      // require a complete active-run search; auth/network errors still stop.
      if (!(error instanceof Error) || error.message !== "github-run-check-http-404") throw error;
    }
  }
  // A 204 dispatch response does not supply a run ID. The workflow run-name
  // carries the durable ID, including while GitHub is waiting for a runner or
  // environment approval. Query every nonterminal status; fail closed if any
  // status page is incomplete or unreadable, rather than dispatching duplicates.
  const pages = await Promise.all(["queued", "in_progress", "waiting", "pending", "requested"].map(async (status) => {
    const params = new URLSearchParams({ status, event: "workflow_dispatch", branch: "main", per_page: "100" });
    const response = await githubRequest(env, `/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?${params}`);
    const data = await response.json() as { total_count: number; workflow_runs: GithubRun[] };
    if (!Array.isArray(data.workflow_runs) || !Number.isFinite(data.total_count)
      || data.total_count > data.workflow_runs.length || response.headers.get("Link")?.includes('rel="next"')) {
      throw new Error("github-run-list-incomplete");
    }
    return data.workflow_runs;
  }));
  return pages.flat().find((item) => Number.isSafeInteger(item.id) && item.display_title === `EOD ${run.id}`
    && item.head_branch === "main" && item.event === "workflow_dispatch" && item.status !== "completed") ?? null;
}

/** A lower-bound admission check only: the runner still samples account usage
 * and reserves its actual workload. Missing ledgers never masquerade as zero
 * measured usage. Reserve headroom for tiny control writes/ledger overhead. */
async function deferEodDispatchForKnownQuota(env: Env, run: EodRun, now: Date): Promise<boolean> {
  const db=getOpsDb(env), date=now.toISOString().slice(0,10);
  const usage=await db.prepare(`SELECT e.rows_read AS eodReads,e.rows_written AS eodWrites,
    e.reserved_reads AS reservedReads,e.reserved_writes AS reservedWrites,
    a.rows_read AS accountReads,a.rows_written AS accountWrites
    FROM (SELECT ? AS usage_date) day
    LEFT JOIN eod_usage e ON e.usage_date=day.usage_date
    LEFT JOIN market_data_daily_usage a ON a.usage_date=day.usage_date`)
    .bind(date).first<{eodReads:number|null;eodWrites:number|null;reservedReads:number|null;
      reservedWrites:number|null;accountReads:number|null;accountWrites:number|null}>();
  if (!usage) return false;
  const known=(value:number|null):value is number => typeof value==="number" && Number.isFinite(value) && value>=0;
  const reservedReads=known(usage.reservedReads) ? usage.reservedReads : 0;
  const reservedWrites=known(usage.reservedWrites) ? usage.reservedWrites : 0;
  const minimumReads=100, minimumWrites=64;
  const eodBlocked=(known(usage.eodReads) && usage.eodReads+reservedReads+minimumReads>2_500_000)
    || (known(usage.eodWrites) && usage.eodWrites+reservedWrites+minimumWrites>50_000);
  const accountBlocked=(known(usage.accountReads) && usage.accountReads+reservedReads+minimumReads>4_500_000)
    || (known(usage.accountWrites) && usage.accountWrites+reservedWrites+minimumWrites>90_000);
  if (!eodBlocked && !accountBlocked) return false;
  const next=new Date(Date.parse(`${date}T00:00:00Z`)+86_400_000+5*60_000).toISOString();
  const message=`Known ${accountBlocked ? "account" : "EOD"} quota ledger has insufficient control allowance; retry after the UTC reset.`;
  await db.prepare(`UPDATE eod_runs SET status='retrying',stage='dispatch-budget',error_code='resource-budget',
    error_message=?,next_attempt_at=?,updated_at=?,dispatch_token=NULL
    WHERE id=? AND status<>'completed' AND (lease_until IS NULL OR lease_until<=?)
      AND (next_attempt_at IS NULL OR next_attempt_at<=?)`)
    .bind(message,next,now.toISOString(),run.id,now.toISOString(),now.toISOString()).run();
  return true;
}

export async function dispatchEodRun(env: Env, run: EodRun, now = new Date()): Promise<void> {
  const timestamp = now.toISOString();
  if (run.status === "completed" || (run.lease_until && run.lease_until > timestamp)
    || (run.next_attempt_at && run.next_attempt_at > timestamp)) return;
  // Admin retries may clear next_attempt_at; the session close gate still
  // applies independently of retry state, including future backfill requests.
  if (run.deadline_at && now.getTime() < Date.parse(run.deadline_at) - 100 * 60_000) return;
  if (await deferEodDispatchForKnownQuota(env,run,now)) return;
  if (!env.EOD_GITHUB_TOKEN) throw new Error("EOD_GITHUB_TOKEN is not configured.");
  const repository = env.EOD_GITHUB_REPOSITORY ?? "d0ofus/market-overview";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid EOD GitHub repository.");
  const workflow = env.EOD_GITHUB_WORKFLOW ?? "eod-market-data.yml";
  const db = getOpsDb(env);
  const token = crypto.randomUUID();
  const next = new Date(now.getTime() + 15 * 60_000).toISOString();
  const claim = await db.prepare(`UPDATE eod_runs SET status='dispatching',dispatch_token=?,
    next_attempt_at=?,dispatch_checked_at=?,updated_at=? WHERE id=? AND status<>'completed'
    AND (lease_until IS NULL OR lease_until<=?) AND (next_attempt_at IS NULL OR next_attempt_at<=?)`)
    .bind(token,next,timestamp,timestamp,run.id,timestamp,timestamp).run();
  if (!claim.meta.changes) return;
  try {
    const current = await db.prepare("SELECT * FROM eod_runs WHERE id=?").bind(run.id).first<EodRun>();
    if (!current) throw new Error("EOD dispatch state disappeared.");
    const existing = await findActiveGithubRun(env,repository,workflow,current);
    if (existing) {
      await db.prepare(`UPDATE eod_runs SET status='dispatched',github_run_id=?,dispatch_token=NULL,
        next_attempt_at=?,updated_at=? WHERE id=? AND dispatch_token=?
        AND (lease_until IS NULL OR lease_until<=?)`)
        .bind(String(existing.id),next,timestamp,run.id,token,timestamp).run();
      return;
    }
    // Reserve the send durably before POST. A timeout is ambiguous; the next
    // attempt checks GitHub first and discovers an accepted-but-unacknowledged run.
    const sending = await db.prepare(`UPDATE eod_runs SET dispatch_requested_at=?,github_run_id=NULL
      WHERE id=? AND dispatch_token=? AND (lease_until IS NULL OR lease_until<=?) AND status<>'completed'`)
      .bind(timestamp,run.id,token,timestamp).run();
    if (!sending.meta.changes) return;
    await githubRequest(env, `/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method:"POST",body:JSON.stringify({ref:"main",inputs:{run_id:run.id}}),
    });
    await db.prepare(`UPDATE eod_runs SET attempt=attempt+1,dispatch_token=NULL,
      status=CASE WHEN status='dispatching' THEN 'dispatched' ELSE status END,updated_at=?
      WHERE id=? AND dispatch_token=?`).bind(timestamp,run.id,token).run();
  } catch (error) {
    await db.prepare(`UPDATE eod_runs SET status='retrying',dispatch_token=NULL,
      error_code='dispatch-failed',error_message=?,updated_at=? WHERE id=? AND dispatch_token=?
      AND (lease_until IS NULL OR lease_until<=?)`)
      .bind(error instanceof Error ? error.message : "dispatch-failed",timestamp,run.id,token,timestamp).run();
    throw error;
  }
}

/** Record the session outcome once. Catalog ingestion/maintenance can continue
 * after all page scopes published; it does not decide the page delivery SLA. */
export async function checkEodDeadlines(env: Env, now = new Date()): Promise<void> {
  const ops = getOpsDb(env);
  const withoutDeadline = await ops.prepare("SELECT id,session_date FROM eod_runs WHERE mode=? AND deadline_at IS NULL LIMIT 24")
    .bind(env.EOD_RUNNER_MODE).all<{id:string;session_date:string}>();
  for (const run of withoutDeadline.results) {
    const session = await getMarketDataDb(env).prepare("SELECT close_at AS closeAt FROM market_calendar_sessions WHERE session_date=?")
      .bind(run.session_date).first<{closeAt:string}>();
    if (session) await ops.prepare("UPDATE eod_runs SET deadline_at=? WHERE id=? AND deadline_at IS NULL")
      .bind(eodDeadline(run.session_date,session.closeAt),run.id).run();
  }
  const runs = await ops.prepare(`SELECT * FROM eod_runs WHERE mode=? AND deadline_at<=?
    AND deadline_checked_at IS NULL ORDER BY deadline_at,id LIMIT 24`)
    .bind(env.EOD_RUNNER_MODE,now.toISOString()).all<EodRun>();
  for (const run of runs.results) {
    const published = await getMarketDataDb(env).prepare(`SELECT DISTINCT scope FROM eod_publications
      WHERE session_date=? AND status='accepted' AND accepted_at IS NOT NULL AND accepted_at<=?`)
      .bind(run.session_date,run.deadline_at).all<{scope:string}>();
    const missing = EOD_PUBLICATION_SCOPES.filter((scope) => !published.results.some((row) => row.scope === scope));
    await ops.prepare(`UPDATE eod_runs SET deadline_missed=?,deadline_checked_at=?,deadline_missing_scopes_json=?
      WHERE id=? AND deadline_checked_at IS NULL`)
      .bind(missing.length > 0 ? 1 : 0,now.toISOString(),JSON.stringify(missing),run.id).run();
  }
}

/** Two indexed control reads, independent of catalog size/publication history. */
export async function eodInputCorrectionStatus(env: Env, sessionDate: string | null): Promise<EodInputCorrectionStatus & {
  completedRunId: string | null; recoveryActive: boolean;
}> {
  if (!sessionDate) return {inputRevision:null,completedInputRevision:null,inputCorrectionsPending:null,
    completedRunId:null,recoveryActive:false};
  const [clock, completed] = await Promise.all([
    getMarketDataDb(env).prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first<{revision:number}>(),
    getOpsDb(env).prepare(`SELECT id,completed_input_clock,
      EXISTS (SELECT 1 FROM eod_runs pending WHERE pending.mode=? AND pending.session_date=?
        AND pending.purpose IN ('daily','reconcile')
        AND pending.status IN ('queued','retrying','running','dispatching','dispatched')) AS recovery_active
      FROM eod_runs WHERE mode=? AND session_date=? AND purpose IN ('daily','reconcile') AND status='completed'
      ORDER BY COALESCE(completed_at,updated_at) DESC,updated_at DESC,id DESC LIMIT 1`)
      .bind(env.EOD_RUNNER_MODE,sessionDate,env.EOD_RUNNER_MODE,sessionDate)
      .first<{id:string;completed_input_clock:number|null;recovery_active:number}>(),
  ]);
  const revision=clock?.revision;
  const inputRevision=typeof revision==="number" && Number.isSafeInteger(revision) && revision>=0 ? revision : null;
  const watermark=completed?.completed_input_clock;
  const completedInputRevision=typeof watermark==="number" && Number.isSafeInteger(watermark) && watermark>=0 ? watermark : null;
  return {inputRevision,completedInputRevision,
    // A missing old watermark triggers one reconciliation. The two databases
    // can be read across a completion race; an apparently lower clock is unknown,
    // not evidence for dispatching an unnecessary new reconciliation.
    inputCorrectionsPending:inputRevision===null || !completed
      || (completedInputRevision!==null && inputRevision<completedInputRevision)
      ? null : completedInputRevision===null || inputRevision>completedInputRevision,
    completedRunId:completed?.id ?? null,recoveryActive:Boolean(completed?.recovery_active)};
}

export async function scheduleEodInputCorrections(env: Env, sessionDate: string | null, now = new Date()): Promise<void> {
  if (!eodEnabled(env) || !sessionDate) return;
  const state=await eodInputCorrectionStatus(env,sessionDate);
  if (state.inputCorrectionsPending!==true || state.recoveryActive) return;
  const run=await enqueueEodRun(env,sessionDate,"reconcile",now);
  if (run.status!=="completed") return; // New queue or existing retry retains its own retry clock/lease.
  await getOpsDb(env).prepare(`UPDATE eod_runs SET status='queued',stage='queued',input_json='{}',progress_json='{}',
    completed_at=NULL,error_code=NULL,error_message=NULL,next_attempt_at=?,updated_at=?
    WHERE id=? AND status='completed' AND updated_at=? AND dispatch_token IS NULL
      AND (lease_until IS NULL OR lease_until<=?) AND (next_attempt_at IS NULL OR next_attempt_at<=?)
      AND NOT EXISTS (SELECT 1 FROM eod_runs pending WHERE pending.mode=? AND pending.session_date=?
        AND pending.purpose IN ('daily','reconcile')
        AND pending.status IN ('queued','retrying','running','dispatching','dispatched'))`)
    .bind(now.toISOString(),now.toISOString(),run.id,run.updated_at,now.toISOString(),now.toISOString(),
      env.EOD_RUNNER_MODE,sessionDate).run();
}

export async function coordinateEod(env: Env, now = new Date()): Promise<void> {
  if (!eodEnabled(env)) return;
  await checkEodDeadlines(env,now);
  const local = zonedParts(now,"America/New_York");
  // Coverage fetch is internally cached; a failed refresh must not fabricate session times.
  await ensureMarketCalendarCoverage(env,local.localDate);
  const db = getMarketDataDb(env);
  const today = await db.prepare("SELECT session_date as sessionDate,close_at as closeAt FROM market_calendar_sessions WHERE session_date=?")
    .bind(local.localDate).first<{sessionDate:string;closeAt:string}>();
  if (today) {
    const slot = eodSlot(now,today);
    if (slot) {
      const run = await enqueueEodRun(env,today.sessionDate,"daily",now);
      if (slot === "deadline") {
        await checkEodDeadlines(env,now);
      } else {
        const maxAttempt = slot === "first" ? 1 : slot === "retry" ? 2 : 3;
        if (run.attempt < maxAttempt) await dispatchEodRun(env,run,now);
      }
    }
    if (local.minutesOfDay >= 9*60 && local.minutesOfDay < 10*60) {
      const previous = await db.prepare("SELECT session_date as date FROM market_calendar_sessions WHERE session_date<? ORDER BY session_date DESC LIMIT 1")
        .bind(local.localDate).first<{date:string}>();
      if (previous) await dispatchEodRun(env,await enqueueEodRun(env,previous.date,"reconcile",now),now);
    }
  } else if (local.weekday === "Sat" && local.minutesOfDay >= 9*60 && local.minutesOfDay < 10*60) {
    const previous = await db.prepare("SELECT session_date as date FROM market_calendar_sessions WHERE session_date<? ORDER BY session_date DESC LIMIT 1")
      .bind(local.localDate).first<{date:string}>();
    if (previous) await dispatchEodRun(env,await enqueueEodRun(env,previous.date,"maintenance",now),now);
  }
  // Date-matching publications can still contain superseded values. The input
  // clock catches changes by any writer without polling full ticker manifests.
  await scheduleEodInputCorrections(env,await expectedEodSession(env,now),now);
  // A missed runner or an exhausted UTC allowance must recover even when the
  // original close window has ended. Prioritize the newest unfinished session.
  const due=await getOpsDb(env).prepare(`SELECT * FROM eod_runs WHERE mode=?
    AND status IN ('queued','retrying','dispatching','dispatched','running')
    AND (lease_until IS NULL OR lease_until<=?) AND (next_attempt_at IS NULL OR next_attempt_at<=?)
    AND (session_date<? OR purpose<>'daily' OR deadline_at<=?)
    ORDER BY session_date DESC,CASE purpose WHEN 'daily' THEN 0 WHEN 'reconcile' THEN 1 ELSE 2 END LIMIT 1`)
    .bind(env.EOD_RUNNER_MODE,now.toISOString(),now.toISOString(),local.localDate,now.toISOString()).first<EodRun>();
  if (due) await dispatchEodRun(env,due,now);
}

function objectJson(value: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

export async function eodStatus(env: Env, now = new Date()) {
  if (!eodEnabled(env)) return {mode:"disabled",runs:[],publications:[],ready:false,
    inputRevision:null,completedInputRevision:null,inputCorrectionsPending:null,
    expectedSession:null,missingScopes:[],lastSuccessfulSession:null,scopeHealth:[],
    usage:null,accountUsage:null,quota:undefined,capacity:undefined};
  const runs = await getOpsDb(env).prepare(
    `SELECT id,session_date,purpose,mode,status,stage,attempt,lease_until,next_attempt_at,deadline_at,
      deadline_missed,deadline_checked_at,deadline_missing_scopes_json,dispatch_checked_at,dispatch_requested_at,
      github_run_id,error_code,error_message,progress_json,updated_at,completed_at,history_tickers_json,history_sessions,completed_input_clock
      FROM eod_runs WHERE mode=? ORDER BY created_at DESC,id DESC LIMIT 12`,
  ).bind(env.EOD_RUNNER_MODE).all<EodRun>();
  const publications = await getMarketDataDb(env).prepare(`SELECT h.scope,h.publication_id,h.session_date,h.published_at
    FROM eod_publication_pointers h JOIN eod_publications p ON p.id=h.publication_id
      AND p.scope=h.scope AND p.session_date=h.session_date AND p.status='accepted'
    WHERE h.scope IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(EOD_PUBLICATION_SCOPES)).all<{scope:string;session_date:string;publication_id:string;published_at:string}>();
  const expectedSession=await expectedEodSession(env,now);
  const {completedRunId: _completedRunId,recoveryActive: _recoveryActive,...corrections}=await eodInputCorrectionStatus(env,expectedSession);
  const today=now.toISOString().slice(0,10);
  const usage=await getOpsDb(env).prepare("SELECT * FROM eod_usage WHERE usage_date=?").bind(today)
    .first<{rows_read:number;rows_written:number;reserved_reads:number;reserved_writes:number}>();
  const accountUsage=await getOpsDb(env).prepare("SELECT usage_date,rows_read,rows_written,sampled_at,error FROM eod_account_usage WHERE usage_date=?")
    .bind(today).first<{usage_date:string;rows_read:number;rows_written:number;sampled_at:string;error:string|null}>();
  const missingScopes=EOD_PUBLICATION_SCOPES.filter((scope) => !publications.results.some((row) => row.scope===scope && row.session_date===expectedSession));
  // Completed active daily/reconcile runs certify all six page scopes. Use the
  // small indexed control ledger instead of grouping all publication history
  // on every visible browser poll. Maintenance completion proves no page data.
  const lastComplete=await getOpsDb(env).prepare(`SELECT session_date AS date FROM eod_runs
    WHERE mode='active' AND status='completed' AND purpose IN ('daily','reconcile') AND session_date<=?
      AND json_array_length(progress_json,'$.published')=6
    ORDER BY session_date DESC LIMIT 1`)
    .bind(expectedSession ?? "0001-01-01").first<{date:string}>();
  const publicRuns=runs.results.map(({progress_json,deadline_missing_scopes_json,history_tickers_json,history_sessions,...run}) => {
    const progress=objectJson(progress_json);
    const errors=progress.errors && typeof progress.errors==="object" && !Array.isArray(progress.errors)
      ? Object.fromEntries(Object.entries(progress.errors).filter((entry):entry is [string,string] => typeof entry[1]==="string")
        .slice(0,50).map(([ticker,message]) => [ticker,message.slice(0,300)])) : {};
    let missing: unknown;
    try { missing=JSON.parse(deadline_missing_scopes_json ?? "[]"); } catch { missing=[]; }
    return {...run,...eodRunHistorySelection({history_tickers_json,history_sessions}),
      failedStage:run.error_code ? run.stage : null,providerErrors:errors,
      deadlineMissingScopes:Array.isArray(missing) ? missing.filter((scope):scope is string => typeof scope==="string") : [],
      deadlineAppliesToDelivery:run.purpose==="daily" && run.mode==="active"};
  });
  const unfinished=publicRuns.filter((run) => run.status!=="completed");
  const quotaBlocked=unfinished.some((run) => /budget|quota/i.test(`${run.error_code} ${run.error_message}`));
  const capacityBlocked=unfinished.some((run) => /capacity/i.test(`${run.error_code} ${run.error_message}`));
  return {mode:env.EOD_RUNNER_MODE,expectedSession,runs:publicRuns,publications:publications.results,usage,accountUsage,...corrections,
    missingScopes,lastSuccessfulSession:lastComplete?.date ?? null,
    scopeHealth:EOD_PUBLICATION_SCOPES.map((scope) => {
      const head=publications.results.find((row) => row.scope===scope);
      return {scope,sessionDate:head?.session_date ?? null,publicationId:head?.publication_id ?? null,
        status:!head ? "missing" : head.session_date===expectedSession ? "current" : "stale"};
    }),
    quota:{status:quotaBlocked ? "blocked" : usage ? "recorded" : "unknown",scope:"eod-runner-recorded-usage",usageDate:today,
      rowsRead:usage?.rows_read ?? null,rowsWritten:usage?.rows_written ?? null,
      reservedReads:usage?.reserved_reads ?? null,reservedWrites:usage?.reserved_writes ?? null,
      resetAt:new Date(Date.parse(`${today}T00:00:00Z`)+86_400_000).toISOString(),
      nextAttemptAt:unfinished.filter((run) => /budget|quota/i.test(`${run.error_code} ${run.error_message}`))
        .map((run) => run.next_attempt_at).filter((date):date is string => Boolean(date)).sort()[0] ?? null},
    capacity:{status:capacityBlocked ? "blocked" : "unknown",warning:capacityBlocked ? "A runner stopped at its D1 storage safety limit." : null},
    ready:env.EOD_RUNNER_MODE==="active" && Boolean(expectedSession) && missingScopes.length===0
      && corrections.inputCorrectionsPending===false};
}

export function registerEodRoutes(app: Hono<{Bindings:Env}>) {
  app.get("/api/eod/status",async (c) => {
    c.header("Cache-Control","no-store");
    return c.json(await eodStatus(c.env));
  });
  app.get("/api/health/market-data",async (c) => {
    c.header("Cache-Control","no-store");
    const status = await eodStatus(c.env);
    return c.json(status,status.ready ? 200 : 503);
  });
  app.post("/api/admin/eod/runs",async (c) => {
    if (!c.env.ADMIN_SECRET || !isAdminRequestAuthorized(c.req.raw,c.env)) return c.json({error:"Unauthorized"},401);
    const input = eodEnqueueSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({error:input.error.flatten()},400);
    const session = await getMarketDataDb(c.env).prepare("SELECT session_date FROM market_calendar_sessions WHERE session_date=?")
      .bind(input.data.sessionDate).first();
    if (!session) return c.json({error:"Unknown exchange session"},400);
    let run: EodRun;
    try {
      run = await enqueueEodRun(c.env,input.data.sessionDate,input.data.purpose,new Date(), {
        historyTickers: input.data.historyTickers, historySessions: input.data.historySessions,
      });
    } catch (error) {
      if (error instanceof EodHistoryRequestBusyError) return c.json({error:"history-request-busy",message:error.message},409);
      throw error;
    }
    if (input.data.retry && run.status !== "running") {
      const reset=await getOpsDb(c.env).prepare(`UPDATE eod_runs SET status='queued',next_attempt_at=NULL,completed_at=NULL
        WHERE id=? AND status NOT IN ('running','dispatching') AND (lease_until IS NULL OR lease_until<=?)`)
        .bind(run.id,new Date().toISOString()).run();
      if (reset.meta.changes) { run.status="queued"; run.next_attempt_at=null; }
    }
    await dispatchEodRun(c.env,run);
    const persisted = await getOpsDb(c.env).prepare("SELECT * FROM eod_runs WHERE id=?").bind(run.id).first<EodRun>();
    return c.json({runId:run.id,status:persisted?.status ?? run.status,
      ...eodRunHistorySelection(persisted ?? run)},202);
  });
}
