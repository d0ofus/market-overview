/** A short-lived cache for one parity batch between complete frozen-capture
 * checks. Query text AND positional parameters are exact keys, so different
 * date ranges, feeds and trailing limits still execute the real reader SQL.
 * Nothing is cached across checkpoints, processes, or a capture release. */
export function createStorageCapturedReadCache(maxBytes=24*1024*1024): (db:D1Database)=>D1Database {
  if (!Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>24*1024*1024) throw new Error("storage-read-cache-invalid-bound");
  const databases=new Map<D1Database,D1Database>();
  let bytes=0;
  return (db:D1Database):D1Database => {
    const existing=databases.get(db);if(existing)return existing;
    const completed=new Map<string,D1Result>(),pending=new Map<string,Promise<D1Result>>();
    class Statement {
      constructor(readonly sql:string,readonly params:unknown[]=[]) {}
      bind(...params:unknown[]) {return new Statement(this.sql,params);}
      async all<T=Record<string,unknown>>():Promise<D1Result<T>> {
        if (!/^\s*SELECT\b/i.test(this.sql)) throw new Error("storage-captured-reader-mutation-forbidden");
        const key=JSON.stringify([this.sql,this.params]);
        const cached=completed.get(key);if(cached)return structuredClone(cached) as D1Result<T>;
        let request=pending.get(key);
        if (!request) {
          request=(async () => {
            const result=await db.prepare(this.sql).bind(...this.params).all();
            const size=new TextEncoder().encode(JSON.stringify(result)).length+key.length*2;
            if (size<=maxBytes-bytes) {completed.set(key,result);bytes+=size;}
            return result;
          })();
          pending.set(key,request);
        }
        try {return structuredClone(await request) as D1Result<T>;} finally {pending.delete(key);}
      }
      async first<T=Record<string,unknown>>(column?:string):Promise<T|null> {
        const row=(await this.all<Record<string,unknown>>()).results[0];
        return row ? (column ? row[column] : row) as T : null;
      }
      async run():Promise<never> {throw new Error("storage-captured-reader-mutation-forbidden");}
    }
    const wrapped={prepare:(sql:string)=>new Statement(sql),batch:async()=>{throw new Error("storage-captured-reader-batch-unsupported");}} as unknown as D1Database;
    databases.set(db,wrapped);return wrapped;
  };
}
