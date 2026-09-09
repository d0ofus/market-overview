import { STORAGE_TABLES } from "./market-storage-schema";

export type StorageCell = string | number | null;
export type StorageRow = Record<string, StorageCell>;
export type StorageTable = {name:string;columns:readonly string[];key:readonly string[];sql:string};
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
export async function readStoragePage(db:D1Database,table:StorageTable,after:StorageCell[]|null,limit=250):Promise<StorageRow[]> {
  if (!Number.isInteger(limit) || limit<1 || limit>250 || (after && after.length!==table.key.length)) throw new Error("storage-page-invalid");
  const key=table.key.map(quoteStorageIdentifier).join(",");
  const where=after ? `WHERE (${key}) > (${after.map(() => "?").join(",")})` : "";
  const result=await db.prepare(`SELECT ${table.columns.map(quoteStorageIdentifier).join(",")} FROM ${quoteStorageIdentifier(table.name)}
    ${where} ORDER BY ${key} LIMIT ${limit} /* storage-copy-page */`).bind(...(after ?? [])).all<StorageRow>();
  for (const row of result.results) storageRowKey(table,row);
  return result.results;
}
/** Destination has indexes but no business triggers until every data table is
 * copied. Existing rows must be byte-equivalent, so retries cannot overwrite a
 * concurrently modified destination and conceal the conflict. */
export async function copyStorageRows(target:D1Database,table:StorageTable,rows:StorageRow[]):Promise<void> {
  if (!rows.length) return;
  if (rows.length>100) throw new Error("storage-copy-invalid-batch");
  const json=canonicalStorageRows(table,rows);
  if (new TextEncoder().encode(json).length>1_800_000) {
    if (rows.length===1) throw new Error("storage-copy-row-exceeds-d1-limit");
    const middle=Math.floor(rows.length/2);
    await copyStorageRows(target,table,rows.slice(0,middle));
    await copyStorageRows(target,table,rows.slice(middle));
    return;
  }
  await target.prepare(`INSERT INTO ${quoteStorageIdentifier(table.name)} (${table.columns.map(quoteStorageIdentifier).join(",")})
    SELECT ${table.columns.map((_,index) => `json_extract(value,'$[${index}]')`).join(",")} FROM json_each(?) WHERE 1
    ON CONFLICT DO NOTHING /* storage-copy-insert */`).bind(json).run();
  const key=table.key.map(quoteStorageIdentifier).join(","), marks=table.key.map(() => "?").join(",");
  const actual=await target.prepare(`SELECT ${table.columns.map(quoteStorageIdentifier).join(",")} FROM ${quoteStorageIdentifier(table.name)}
    WHERE (${key}) >= (${marks}) AND (${key}) <= (${marks}) ORDER BY ${key} LIMIT 101 /* storage-copy-page */`)
    .bind(...storageRowKey(table,rows[0]),...storageRowKey(table,rows.at(-1)!)).all<StorageRow>();
  if (canonicalStorageRows(table,actual.results)!==json) throw new Error("storage-target-readback-mismatch");
}
