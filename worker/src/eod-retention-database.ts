/** Used only by independent securities in the GitHub retention job. Dependent
 * operations still await their own result; each existing transaction stays
 * intact. Four callers share one REST request without changing SQL or binding
 * scope. A failed transaction rejects every caller, leaving work replayable. */
export function retentionDatabase(database: D1Database, callers: 4 | 8 = 4): D1Database {
  type Pending = { statements: D1PreparedStatement[]; resolve: (value: D1Result[]) => void; reject: (reason: unknown) => void };
  let queue: Pending[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    timer = undefined;
    const pending = queue;
    queue = [];
    try {
      const results = await database.batch(pending.flatMap((item) => item.statements));
      let offset = 0;
      for (const item of pending) {
        item.resolve(results.slice(offset, offset + item.statements.length));
        offset += item.statements.length;
      }
    } catch (error) { for (const item of pending) item.reject(error); }
  };
  const enqueue = (statements: D1PreparedStatement[]): Promise<D1Result[]> => {
    if (statements.length > 10) return database.batch(statements);
    if (queue.length >= callers || queue.reduce((total, item) => total + item.statements.length, 0) + statements.length > 40) {
      if (timer) clearTimeout(timer);
      void flush();
    }
    return new Promise((resolve, reject) => {
      queue.push({ statements, resolve, reject });
      timer ??= setTimeout(() => { void flush(); }, 1);
    });
  };
  class Statement {
    constructor(readonly original: D1PreparedStatement) {}
    bind(...values: unknown[]) { return new Statement(this.original.bind(...values)); }
    async all<T>() { return (await enqueue([this.original]))[0] as D1Result<T>; }
    async run<T>() { return this.all<T>(); }
    async first<T>(column?: string): Promise<T | null> {
      const row = (await this.all<Record<string, unknown>>()).results[0];
      return row ? (column ? row[column] : row) as T : null;
    }
  }
  return {
    prepare: (sql: string) => new Statement(database.prepare(sql)),
    batch: <T>(statements: Statement[]) => enqueue(statements.map((statement) => statement.original)) as Promise<D1Result<T>[]>,
  } as unknown as D1Database;
}
