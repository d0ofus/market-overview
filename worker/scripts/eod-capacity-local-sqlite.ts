import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

// A persistent local Python connection avoids spawning a process for each
// captured page/reader query. It never opens a URL or a remote database.
const bridge = String.raw`import json,sqlite3,sys
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
for line in sys.stdin:
 try:
  request=json.loads(line)
  if 'script' in request:
   db.executescript(request['script']);result=[]
  else:
   result=[]
   with db:
    for query in request['queries']:
     before=db.total_changes
     cursor=db.execute(query['sql'],query.get('params',[]))
     rows=[dict(row) for row in cursor.fetchall()] if cursor.description else []
     result.append({'success':True,'results':rows,'meta':{'changes':db.total_changes-before,'rows_read':len(rows),'rows_written':db.total_changes-before}})
   size=db.execute('PRAGMA page_count').fetchone()[0]*db.execute('PRAGMA page_size').fetchone()[0]
   for item in result:item['meta']['size_after']=size
  print(json.dumps({'ok':True,'result':result},separators=(',',':'),allow_nan=False),flush=True)
 except Exception:
  print(json.dumps({'ok':False}),flush=True)
db.close()
`;
export function createCapacityLocalSqlite(file: string) {
  const child = spawn("python", ["-u", "-c", bridge, resolve(file)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  let closed = false, failed = false;
  const pending: Array<{ resolve(value: D1Result[]): void; reject(error: Error): void }> = [];
  const failure = () => { failed = true; while (pending.length) pending.shift()!.reject(new Error("eod-capacity-local-sqlite-failed")); };
  child.once("error", failure); child.once("exit", () => { if (!closed) failure(); });
  // Never forward SQL, stored data or stderr into public workflow logs.
  child.stderr.on("data", () => undefined);
  lines.on("line", (line) => {
    const next = pending.shift();
    if (!next) { failure(); return; }
    try {
      const response = JSON.parse(line) as { ok: boolean; result: D1Result[] };
      if (response.ok !== true) throw new Error();
      next.resolve(response.result);
    } catch { next.reject(new Error("eod-capacity-local-sqlite-query-failed")); }
  });
  const invoke = (request: unknown): Promise<D1Result[]> => {
    if (closed || failed) return Promise.reject(new Error("eod-capacity-local-sqlite-closed"));
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > 16 * 1024 * 1024) return Promise.reject(new Error("eod-capacity-local-query-too-large"));
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      child.stdin.write(body + "\n", (error) => { if (error) failure(); });
    });
  };
  class Statement {
    constructor(readonly sql: string, readonly params: unknown[] = []) {}
    bind(...params: unknown[]) { return new Statement(this.sql, params); }
    async all<T = Record<string, unknown>>() { return (await invoke({ queries: [this] }))[0] as D1Result<T>; }
    run<T = Record<string, unknown>>() { return this.all<T>(); }
    async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
      const row = (await this.all<Record<string, unknown>>()).results[0];
      return row ? (column ? row[column] : row) as T : null;
    }
  }
  return {
    db: { prepare: (sql: string) => new Statement(sql), batch: (queries: Statement[]) => invoke({ queries }) } as unknown as D1Database,
    script: async (sql: string) => { await invoke({ script: sql }); },
    async close(): Promise<void> {
      if (closed) return;
      if (pending.length) throw new Error("eod-capacity-local-sqlite-pending");
      closed = true;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 5_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.stdin.end();
      });
      lines.close();
    },
  };
}
