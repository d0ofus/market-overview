/** Existing queued GitHub runs can start after a storage coordinator takes
 * ownership. Check their actual database before any provider/price work. */
export async function eodStorageWriterDisposition(ops:D1Database,databaseId:string):Promise<"canonical"|"migration-in-progress"|"retired-source"> {
  const rows=await ops.prepare(`SELECT source_database_id,target_database_id,status FROM market_storage_migrations
    WHERE source_database_id=? OR target_database_id=? ORDER BY created_at DESC LIMIT 100`)
    .bind(databaseId,databaseId).all<{source_database_id:string;target_database_id:string;status:string}>();
  if(rows.results.length>=100)throw new Error("eod-storage-ownership-history-incomplete");
  if(rows.results.some(row=>!["completed","aborted"].includes(row.status)))return "migration-in-progress";
  if(rows.results.some(row=>row.source_database_id===databaseId && row.status==="completed"))return "retired-source";
  return "canonical";
}
