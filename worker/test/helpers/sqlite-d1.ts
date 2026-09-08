import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Real SQLite SQL/transactions/constraints through Python's standard library.
// This helper never opens a repository or remote database.
const bridge = `import json, sqlite3, sys
request=json.load(sys.stdin)
db=sqlite3.connect(sys.argv[1])
db.row_factory=sqlite3.Row
db.execute('PRAGMA foreign_keys=ON')
result=[]
try:
 if 'script' in request:
  db.executescript(request['script'])
 else:
  with db:
   for query in request['queries']:
    before=db.total_changes
    cursor=db.execute(query['sql'],query['params'])
    rows=[dict(row) for row in cursor.fetchall()] if cursor.description else []
    result.append({'success':True,'results':rows,'meta':{'changes':max(0,cursor.rowcount),'rows_read':len(rows),'rows_written':db.total_changes-before}})
  physical_bytes=db.execute('PRAGMA page_count').fetchone()[0]*db.execute('PRAGMA page_size').fetchone()[0]
  for item in result:
   item['meta']['size_after']=physical_bytes
 print(json.dumps(result))
finally:
 db.close()
`;

export function createSqliteD1() {
  const directory = mkdtempSync(join(tmpdir(), "market-overview-sql-test-"));
  const file = join(directory, "test.sqlite");
  const invoke = (request: unknown): D1Result[] => JSON.parse(execFileSync("python", ["-c", bridge, file], {
    input: JSON.stringify(request), encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  })) as D1Result[];
  class Statement {
    constructor(readonly sql: string, readonly params: unknown[] = []) {}
    bind(...params: unknown[]) { return new Statement(this.sql, params); }
    async all<T = Record<string, unknown>>() { return invoke({ queries: [this] })[0] as D1Result<T>; }
    async run<T = Record<string, unknown>>() { return this.all<T>(); }
    async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
      const row = (await this.all<Record<string, unknown>>()).results[0];
      return row ? (column ? row[column] : row) as T : null;
    }
  }
  const db = {
    prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) => invoke({ queries: statements }),
  } as unknown as D1Database;
  return {
    db,
    script(sql: string) { invoke({ script: sql }); },
    migrate(relativeDirectory: string) {
      const path = resolve(process.cwd(), relativeDirectory);
      const scripts = readdirSync(path).filter((name) => name.endsWith(".sql")).sort()
        .map((file) => readFileSync(join(path, file), "utf8"));
      invoke({ script: scripts.join("\n") });
    },
    dispose() {
      const expectedPrefix = join(tmpdir(), "market-overview-sql-test-");
      if (!directory.startsWith(expectedPrefix)) throw new Error("Unsafe test cleanup path.");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
