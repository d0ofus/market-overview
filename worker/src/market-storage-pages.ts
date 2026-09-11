import { STORAGE_TABLES } from "./market-storage-schema";

export type StorageCell = string | number | null;
export type StorageRow = Record<string, StorageCell>;
export type StorageTable = {name:string;columns:readonly string[];key:readonly string[];sql:string};
export const STORAGE_TABLE_PAGE_ROWS = 250;
export function storageTable(name: string): StorageTable {
  const table=STORAGE_TABLES.find((table) => table.name===name);
  if (!table) throw new Error("storage-table-not-reviewed");
  return table;
}
export function quoteStorageIdentifier(name:string):string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("storage-identifier-invalid");
  return `"${name}"`;
}
export function storageRowKey(table:StorageTable,row:StorageRow):StorageCell[] {
  return table.key.map((key) => {
    if (row[key]===null || row[key]===undefined) throw new Error("storage-null-primary-key");
    return row[key];
  });
}
export function canonicalStorageRows(table:StorageTable,rows:StorageRow[]):string {
  return JSON.stringify(rows.map((row) => table.columns.map((column) => {
    const value=row[column];
    if (value===undefined || (typeof value==="number" && !Number.isFinite(value))) throw new Error("storage-row-invalid");
    return value;
  })));
}
export async function storageHash(value:unknown):Promise<string> {
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map((byte) => byte.toString(16).padStart(2,"0")).join("");
}
export async function readStoragePage(db:D1Database,table:StorageTable,after:StorageCell[]|null,limit=STORAGE_TABLE_PAGE_ROWS):Promise<StorageRow[]> {
  if (!Number.isInteger(limit) || limit<1 || limit>STORAGE_TABLE_PAGE_ROWS || (after && after.length!==table.key.length)) throw new Error("storage-page-invalid");
  const key=table.key.map(quoteStorageIdentifier).join(",");
  const where=after ? `WHERE (${key}) > (${after.map(() => "?").join(",")})` : "";
  const result=await db.prepare(`SELECT ${table.columns.map(quoteStorageIdentifier).join(",")} FROM ${quoteStorageIdentifier(table.name)}
    ${where} ORDER BY ${key} LIMIT ${limit} /* storage-copy-page */`).bind(...(after ?? [])).all<StorageRow>();
  for (const row of result.results) storageRowKey(table,row);
  return result.results;
}

/** Fixed-width price rows have a bounded transport size unlike generic payload
 * tables. This page is also used by read-only capacity captures. */
export async function readStoragePricePage(db:D1Database,after:StorageCell[]|null):Promise<StorageRow[]> {
  const table=storageTable("alpaca_daily_bars");
  if(after && after.length!==table.key.length)throw new Error("storage-page-invalid");
  const key=table.key.map(quoteStorageIdentifier).join(",");
  const where=after ? `WHERE (${key}) > (${after.map(() => "?").join(",")})` : "";
  const rows=(await db.prepare(`SELECT ${table.columns.map(quoteStorageIdentifier).join(",")} FROM "alpaca_daily_bars"
    ${where} ORDER BY ${key} LIMIT 1000 /* storage-price-stream-page */`).bind(...(after ?? [])).all<StorageRow>()).results;
  for(const row of rows)storageRowKey(table,row);
  return rows;
}

/** Stream the immutable source once in bounded keyset pages. Retain only one
 * page plus at most sixteen complete security-years; the durable cursor remains
 * the final verified year, so losing this in-memory buffer is harmless. */
export function createStoragePriceYearReader(db:D1Database,after:StorageCell[]|null) {
  const table=storageTable("alpaca_daily_bars");
  let cursor=after,buffer:StorageRow[]=[],offset=0,exhausted=false;
  const peek=async ():Promise<StorageRow|undefined> => {
    if(offset>=buffer.length && !exhausted) {
      buffer=await readStoragePricePage(db,cursor);
      offset=0;
      if(buffer.length)cursor=storageRowKey(table,buffer.at(-1)!);
      exhausted=buffer.length<1000;
    }
    return buffer[offset];
  };
  return async (maxYears=8):Promise<{groups:StorageRow[][];next:StorageRow|undefined}> => {
    if(!Number.isInteger(maxYears) || maxYears<1 || maxYears>16)throw new Error("storage-year-batch-invalid");
    const groups:StorageRow[][]=[];
    let first=await peek();
    while(first && groups.length<maxYears) {
      const key=JSON.stringify([first.feed,first.ticker,String(first.date).slice(0,4)]),rows:StorageRow[]=[];
      do {
        rows.push(first);offset++;
        if(rows.length>366)throw new Error("storage-year-observations-invalid");
        first=await peek();
      } while(first && JSON.stringify([first.feed,first.ticker,String(first.date).slice(0,4)])===key);
      groups.push(rows);
    }
    return {groups,next:first};
  };
}
/** Destination has indexes but no business triggers until every data table is
 * copied. Existing rows must be byte-equivalent, so retries cannot overwrite a
 * concurrently modified destination and conceal the conflict. */
export async function copyStorageRows(target:D1Database,table:StorageTable,rows:StorageRow[]):Promise<void> {
  if (!rows.length) return;
  if (rows.length>STORAGE_TABLE_PAGE_ROWS) throw new Error("storage-copy-invalid-batch");
  const json=canonicalStorageRows(table,rows);
  if (new TextEncoder().encode(json).length>1_800_000) {
    if (rows.length===1) throw new Error("storage-copy-row-exceeds-d1-limit");
    const middle=Math.floor(rows.length/2);
    await copyStorageRows(target,table,rows.slice(0,middle));
    await copyStorageRows(target,table,rows.slice(middle));
    return;
  }
  const insert=target.prepare(`INSERT INTO ${quoteStorageIdentifier(table.name)} (${table.columns.map(quoteStorageIdentifier).join(",")})
    SELECT ${table.columns.map((_,index) => `json_extract(value,'$[${index}]')`).join(",")} FROM json_each(?) WHERE 1
    ON CONFLICT DO NOTHING /* storage-copy-insert */`).bind(json);
  const key=table.key.map(quoteStorageIdentifier).join(","), marks=table.key.map(() => "?").join(",");
  const readback=target.prepare(`SELECT ${table.columns.map(quoteStorageIdentifier).join(",")} FROM ${quoteStorageIdentifier(table.name)}
    WHERE (${key}) >= (${marks}) AND (${key}) <= (${marks}) ORDER BY ${key} LIMIT ${rows.length+1} /* storage-copy-page */`)
    .bind(...storageRowKey(table,rows[0]),...storageRowKey(table,rows.at(-1)!));
  // D1 executes these in order in one transaction. Replay remains idempotent,
  // and verification observes exactly the destination committed by this batch.
  const actual=(await target.batch<StorageRow>([insert,readback]))[1];
  if (canonicalStorageRows(table,actual.results)!==json) throw new Error("storage-target-readback-mismatch");
}
