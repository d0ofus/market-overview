/** Node-side D1 bridge. Only repository SQL reaches this adapter; it is never an HTTP SQL endpoint. */
export type EodSql = { sql:string; params:unknown[] };
export type EodUsage = { rowsRead:number; rowsWritten:number; sizeAfter:number };
export type D1Settlement = ((usage: EodUsage) => Promise<void>) & { abandon?: () => Promise<void> };
export type D1Admission = (queries: readonly EodSql[]) => Promise<D1Settlement>;
export type EodAdmission = D1Admission & { flush: () => Promise<void> };

export function createEodD1Database(options: {
  accountId:string; databaseId:string; token:string; allowedDatabaseIds:readonly string[];
  admission?:D1Admission; fetcher?:typeof fetch;
}): D1Database {
  if (!/^[a-f0-9]{32}$/i.test(options.accountId)
    || !options.allowedDatabaseIds.includes(options.databaseId)
    || !/^[a-f0-9-]{36}$/i.test(options.databaseId)) throw new Error("D1 database is not allowlisted.");
  const execute = async (queries:EodSql[]):Promise<D1Result[]> => {
    if (queries.length > 40) throw new Error("D1 batch exceeds 40 statements.");
    for (const query of queries) {
      if (query.params.length > 100 || query.sql.length > 90_000
        || /\b(?:DROP|ATTACH|DETACH|VACUUM)\b/i.test(query.sql)) throw new Error("Disallowed EOD SQL.");
    }
    const settle = await options.admission?.(queries);
    // Ambiguous network failures are not automatically replayed: the caller resumes
    // through idempotent checkpoints, and a lost reservation remains charged.
    try {
      const response = await (options.fetcher ?? fetch)(
      `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/d1/database/${options.databaseId}/query`,
      {method:"POST",headers:{Authorization:`Bearer ${options.token}`,"Content-Type":"application/json"},
        body:JSON.stringify(queries.length === 1 ? queries[0] : queries),signal:AbortSignal.timeout(30_000)},
    );
    const body = await response.json() as {success?:boolean;result?:D1Result[];errors?:Array<{message?:string}>};
    if (!response.ok || body.success === false || !Array.isArray(body.result)
      || body.result.some((result) => !result.success)) {
      throw new Error(`d1-http-${response.status}: ${body.errors?.map((error) => error.message).join("; ") ?? "query failed"}`);
    }
    if (body.result.some((result) => !Number.isFinite(result.meta?.rows_read) || Number(result.meta.rows_read) < 0
      || !Number.isFinite(result.meta?.rows_written) || Number(result.meta.rows_written) < 0)) {
      throw new Error("d1-usage-metadata-unavailable");
    }
    const usage = body.result.reduce((sum,result) => ({
      rowsRead:sum.rowsRead+Number(result.meta.rows_read ?? 0),
      rowsWritten:sum.rowsWritten+Number(result.meta.rows_written ?? 0),
      sizeAfter:Math.max(sum.sizeAfter,Number(result.meta.size_after ?? 0)),
    }),{rowsRead:0,rowsWritten:0,sizeAfter:0});
    await settle?.(usage);
      return body.result;
    } catch (error) {
      // A failed/ambiguous request consumes its reserved maximum. This also
      // releases local in-flight bookkeeping so another parallel query cannot deadlock.
      await settle?.abandon?.();
      throw error;
    }
  };
  class Statement {
    constructor(readonly sql:string,readonly params:unknown[] = []) {}
    bind(...params:unknown[]) { return new Statement(this.sql,params); }
    async all<T = Record<string,unknown>>():Promise<D1Result<T>> { return (await execute([this]))[0] as D1Result<T>; }
    async run<T = Record<string,unknown>>():Promise<D1Result<T>> { return this.all<T>(); }
    async first<T = Record<string,unknown>>(column?:string):Promise<T|null> {
      const row = (await this.all<Record<string,unknown>>()).results[0];
      return row ? (column ? row[column] : row) as T : null;
    }
    async raw<T = unknown[]>():Promise<T[]> {
      return (await this.all<Record<string,unknown>>()).results.map((row) => Object.values(row) as T);
    }
  }
  // D1's runtime also exposes dump/exec/session helpers. Domain services use
  // prepared statements and batches only; unsupported methods fail explicitly.
  const database = {
    prepare:(sql:string) => new Statement(sql),
    batch:async <T = Record<string,unknown>>(statements:Statement[]):Promise<D1Result<T>[]> => execute(statements) as Promise<D1Result<T>[]>,
    exec:async () => { throw new Error("EOD adapter requires prepared SQL."); },
    dump:async () => { throw new Error("EOD adapter does not export databases."); },
  };
  return database as unknown as D1Database;
}

const LEDGER_READS = 20;
const LEDGER_WRITES = 12;
const MEMBERSHIP_MARKERS=["delete","insert","pointer","active","supersede"] as const;
function membershipRows(query:EodSql,limit:number):number {
  let rows:unknown;
  try {rows=JSON.parse(String(query.params[1]));} catch {throw new Error("eod-universe-invalid-batch");}
  if (!Array.isArray(rows) || rows.length>limit) throw new Error("eod-universe-invalid-batch");
  return rows.length;
}
function maximumReservationWrites(queries:readonly EodSql[]):number {
  // Only the known five-statement atomic membership promotion may need a
  // larger envelope (cold bootstrap has two indexes plus its table rows).
  if (queries.length!==5 || !MEMBERSHIP_MARKERS.every((marker,index) =>
    queries[index].sql.trimEnd().endsWith(`/* eod-universe-promote-${marker} */`))) return 10_000;
  if (membershipRows(queries[0],8_000)+membershipRows(queries[1],8_000)>8_000) throw new Error("eod-universe-promotion-too-large");
  return 25_000;
}

/** Conservative bounds for the repository's fixed, bounded runner SQL. */
export function estimateEodQueries(queries: readonly EodSql[]): { reads: number; writes: number } {
  let reads = 0;
  let writes = 0;
  for (const query of queries) {
    if (query.sql.trimEnd().endsWith("/* eod-history-catalog-read */")) {
      // The compact catalog's JSON array is traversed even for a small request;
      // include the bounded full population and revision/repair lookup work.
      reads += 50_000;
      continue;
    }
    if (/\/\* eod-history-relocation-(register|delete|cleanup) \*\/$/.test(query.sql.trimEnd())) {
      let rows: unknown;
      try { rows = JSON.parse(String(query.params[1])); } catch { throw new Error("eod-history-relocation-invalid-batch"); }
      if (!Array.isArray(rows) || rows.length > 40) throw new Error("eod-history-relocation-invalid-batch");
      reads += rows.length * 6 + 64;
      writes += rows.length * 4 + 8;
      continue;
    }
    if (/\/\* eod-universe-(stage|prune-members|promote-delete|promote-insert) \*\/$/.test(query.sql.trimEnd())) {
      const rows=membershipRows(query,/promote-/.test(query.sql) ? 8_000 : 400);
      reads+=6*rows+32; writes+=3*rows+8;
      continue;
    }
    if (/\/\* eod-universe-promote-(pointer|active|supersede) \*\/$/.test(query.sql.trimEnd())) {
      reads+=32;writes+=8;continue;
    }
    const mutation = /^\s*(INSERT|UPDATE|DELETE)/i.test(query.sql);
    if (query.sql.includes("LEFT JOIN eod_input_revisions actual")) {
      const serialized=query.params.at(-1);
      let manifest:unknown;
      try {manifest=JSON.parse(String(serialized));} catch {throw new Error("eod-publication-invalid-manifest");}
      if (!Array.isArray(manifest) || manifest.length>20_000) throw new Error("eod-publication-invalid-manifest");
      // Every expected security can probe its source revision and repair fence;
      // allow virtual-table traversal as well as indexed lookups.
      reads+=manifest.length*4+64; writes+=mutation ? 8 : 0;
      continue;
    }
    reads += query.sql.startsWith("/* eod-capacity-row-sample */") ? 50_000 : mutation ? (/json_each/i.test(query.sql) ? 20_000 : 20)
      : /alpaca_daily_bars|universe|symbols|calendar/i.test(query.sql) ? 25_000 : 2_000;
    writes += mutation ? (/json_each/i.test(query.sql) ? 4_000 : 8) : 0;
  }
  return { reads, writes };
}

type Envelope = {
  id: string; date: string; reads: number; writes: number;
  usedReads: number; usedWrites: number; pendingReads: number; pendingWrites: number;
  pending: Set<{ reads: number; writes: number; done: boolean }>;
  draining: boolean; closed: boolean;
};

/**
 * Reserves a bounded credit envelope in one atomic Ops transaction, then settles
 * many SQL requests locally against it. Only opening/closing an envelope writes
 * the quota ledger. The raw Ops adapter must not use this admission recursively.
 */
export function createEodAdmission(ops: D1Database, runId: string, options: {
  reconcileAccountUsage?: () => Promise<unknown>;
  readCredit?: number;
  writeCredit?: number;
  now?: () => Date;
} = {}): EodAdmission {
  const clock = options.now ?? (() => new Date());
  const readCredit = Math.max(LEDGER_READS + 1, Math.min(250_000, Math.trunc(options.readCredit ?? 50_000)));
  const writeCredit = Math.max(LEDGER_WRITES + 1, Math.min(10_000, Math.trunc(options.writeCredit ?? 2_000)));
  if (!Number.isFinite(readCredit) || !Number.isFinite(writeCredit)) throw new Error("Invalid EOD admission credits.");
  const envelopes = new Set<Envelope>();
  let current: Envelope | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let reconciledAt = 0;
  let reconciledDate = "";
  let stopped: Error | null = null;
  let flushed = false;
  // This lock only protects local counters and raw Ops transactions. An admitted
  // query performs its actual I/O outside it, so parallel service calls can finish.
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn, fn);
    queue = result.catch(() => undefined);
    return result;
  }
  async function close(envelope: Envelope): Promise<void> {
    if (envelope.closed || envelope.pending.size) return;
    await ops.batch([
      ops.prepare(`UPDATE eod_usage SET reserved_reads=reserved_reads-?,reserved_writes=reserved_writes-?,
        rows_read=rows_read+?,rows_written=rows_written+?
        WHERE usage_date=? AND EXISTS(SELECT 1 FROM eod_budget_reservations WHERE id=? AND settled=0)`)
        .bind(envelope.reads,envelope.writes,envelope.usedReads,envelope.usedWrites,envelope.date,envelope.id),
      ops.prepare(`INSERT INTO market_data_daily_usage(usage_date,bars_written,rows_read,rows_written,updated_at)
        SELECT ?,0,?,?,CURRENT_TIMESTAMP WHERE EXISTS(SELECT 1 FROM eod_budget_reservations WHERE id=? AND settled=0)
        ON CONFLICT(usage_date) DO UPDATE SET rows_read=rows_read+excluded.rows_read,
          rows_written=rows_written+excluded.rows_written,updated_at=CURRENT_TIMESTAMP`)
        .bind(envelope.date,envelope.usedReads,envelope.usedWrites,envelope.id),
      ops.prepare("UPDATE eod_budget_reservations SET settled=1 WHERE id=?").bind(envelope.id),
    ]);
    envelope.closed = true;
    envelopes.delete(envelope);
    if (current === envelope) current = null;
  }
  async function reserve(date: string, needed: { reads: number; writes: number }, maximumWrites:number): Promise<Envelope> {
    const minimumReads = needed.reads + LEDGER_READS;
    const minimumWrites = needed.writes + LEDGER_WRITES;
    if (minimumReads > 250_000 || minimumWrites > maximumWrites) throw new Error("eod-query-exceeds-bounded-reservation");
    const sizes = [{ reads: Math.max(readCredit, minimumReads), writes: Math.max(writeCredit, minimumWrites) }];
    if (sizes[0].reads !== minimumReads || sizes[0].writes !== minimumWrites) sizes.push({ reads: minimumReads, writes: minimumWrites });
    for (const size of sizes) {
      const id = crypto.randomUUID();
      const result = await ops.batch([
        ops.prepare("INSERT INTO eod_usage(usage_date) VALUES(?) ON CONFLICT DO NOTHING").bind(date),
        ops.prepare(`UPDATE eod_usage SET reserved_reads=reserved_reads+?,reserved_writes=reserved_writes+?
          WHERE usage_date=? AND rows_read+reserved_reads+?<=2500000 AND rows_written+reserved_writes+?<=50000
          AND COALESCE((SELECT rows_read FROM market_data_daily_usage WHERE usage_date=?),0)+reserved_reads+?<=4500000
          AND COALESCE((SELECT rows_written FROM market_data_daily_usage WHERE usage_date=?),0)+reserved_writes+?<=90000`)
          .bind(size.reads,size.writes,date,size.reads,size.writes,date,size.reads,date,size.writes),
        // changes() refers to the immediately preceding guarded UPDATE in this transaction.
        ops.prepare(`INSERT INTO eod_budget_reservations(id,usage_date,run_id,reads,writes,created_at)
          SELECT ?,?,?,?,?,? WHERE changes()=1`).bind(id,date,runId,size.reads,size.writes,clock().toISOString()),
      ]);
      if (!Number(result[1]?.meta?.changes ?? 0)) continue;
      const envelope: Envelope = { id,date,...size,usedReads:LEDGER_READS,usedWrites:LEDGER_WRITES,
        pendingReads:0,pendingWrites:0,pending:new Set(),draining:false,closed:false };
      envelopes.add(envelope);
      return envelope;
    }
    throw new Error(`eod-d1-budget-exhausted; retry after ${date} UTC reset`);
  }
  const admission = (async (queries: readonly EodSql[]): Promise<D1Settlement> => locked(async () => {
    if (stopped) throw stopped;
    if (flushed) throw new Error("eod-admission-already-flushed");
    let now = clock();
    let date = now.toISOString().slice(0, 10);
    if (options.reconcileAccountUsage && (date !== reconciledDate || now.getTime() - reconciledAt >= 5 * 60_000)) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const sampleDate = date;
        await options.reconcileAccountUsage();
        now = clock();
        date = now.toISOString().slice(0, 10);
        if (date === sampleDate) {
          reconciledAt = now.getTime(); reconciledDate = date;
          break;
        }
        // Analytics requested just before midnight describes yesterday. Verify
        // the new UTC allowance before opening or reusing a credit envelope.
        if (attempt === 1) throw new Error("eod-account-usage-date-changed");
      }
    }
    const estimate = estimateEodQueries(queries);
    if (current && (current.date !== date || current.draining
      || current.reads-current.usedReads-current.pendingReads < estimate.reads
      || current.writes-current.usedWrites-current.pendingWrites < estimate.writes)) {
      current.draining = true;
      await close(current);
      current = null;
    }
    const envelope = current ?? await reserve(date, estimate,maximumReservationWrites(queries));
    current = envelope;
    const token = { ...estimate, done: false };
    envelope.pending.add(token);
    envelope.pendingReads += estimate.reads;
    envelope.pendingWrites += estimate.writes;
    const finish = async (usage?: EodUsage): Promise<void> => locked(async () => {
      if (token.done) return;
      token.done = true;
      envelope.pending.delete(token);
      envelope.pendingReads -= token.reads;
      envelope.pendingWrites -= token.writes;
      const reads = usage ? usage.rowsRead : token.reads;
      const writes = usage ? usage.rowsWritten : token.writes;
      if (!Number.isFinite(reads) || reads < 0 || !Number.isFinite(writes) || writes < 0) {
        envelope.usedReads += token.reads; envelope.usedWrites += token.writes;
        stopped = new Error("eod-invalid-d1-usage");
      } else {
        envelope.usedReads += reads; envelope.usedWrites += writes;
        if (reads > token.reads || writes > token.writes) stopped = new Error("eod-d1-query-budget-estimate-exceeded");
      }
      if (usage && usage.sizeAfter >= 400_000_000) stopped = new Error("eod-d1-capacity-critical");
      if (stopped || envelope.date !== clock().toISOString().slice(0, 10)) envelope.draining = true;
      if (envelope.draining) await close(envelope);
      if (stopped) throw stopped;
    });
    const settlement = ((usage: EodUsage) => finish(usage)) as D1Settlement;
    settlement.abandon = () => finish();
    return settlement;
  })) as EodAdmission;
  admission.flush = () => locked(async () => {
    flushed = true;
    // A caller may reach finally while another Promise.all branch is still in
    // flight. Pessimistically charge its slice instead of waiting on an orphan.
    for (const envelope of envelopes) {
      for (const token of envelope.pending) {
        token.done = true;
        envelope.usedReads += token.reads; envelope.usedWrites += token.writes;
      }
      envelope.pending.clear(); envelope.pendingReads = 0; envelope.pendingWrites = 0;
      envelope.draining = true;
      await close(envelope);
    }
    current = null;
  });
  return admission;
}
