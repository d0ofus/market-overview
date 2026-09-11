import { EOD_YAHOO_ARCHIVE_TICKER_LIMIT } from "./eod-storage-layout";

/** A bounded fallback shortage is a per-symbol coverage failure, not a D1
 * outage. Previously reserved securities can still receive corrections. */
export class EodFallbackStorageFullError extends Error {
  constructor() { super("yahoo-fallback-storage-full"); this.name = "EodFallbackStorageFullError"; }
}

export async function assertYahooArchiveCapacity(db: D1Database, ticker: string): Promise<void> {
  const existing = await db.prepare("SELECT 1 AS present FROM market_history_blocks WHERE feed='yahoo-eod' AND ticker=? LIMIT 1")
    .bind(ticker).first();
  if (existing) return;
  const count = await db.prepare(`SELECT COUNT(*) AS count FROM
    (SELECT DISTINCT ticker FROM market_history_blocks WHERE feed='yahoo-eod' LIMIT ?)
    /* eod-yahoo-storage-admission */`).bind(EOD_YAHOO_ARCHIVE_TICKER_LIMIT).first<{ count: number }>();
  if (!count || count.count >= EOD_YAHOO_ARCHIVE_TICKER_LIMIT) throw new EodFallbackStorageFullError();
}

/** The immutable insert reserves a symbol atomically, including unpromoted
 * blocks. Counting pointers alone would allow concurrent first writers to
 * exceed the limit. No publication points to this block until read-back and
 * the normal correction fence have passed. */
export async function reserveYahooArchiveBlock(db: D1Database, block: {
  id: string; feed: string; ticker: string; calendarYear: number; schemaVersion: number; codec: string;
  checksum: string; rowCount: number; firstDate: string; lastDate: string; uncompressedBytes: number; payloadBase64: string;
}): Promise<{ rowsRead: number; rowsWritten: number }> {
  const result = await db.prepare(`INSERT OR IGNORE INTO market_history_blocks
    (id,feed,ticker,calendar_year,schema_version,codec,checksum,row_count,first_date,last_date,uncompressed_bytes,payload_base64)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE CASE
      WHEN EXISTS(SELECT 1 FROM market_history_blocks WHERE feed='yahoo-eod' AND ticker=?) THEN 1
      ELSE (SELECT COUNT(*) FROM (SELECT DISTINCT ticker FROM market_history_blocks WHERE feed='yahoo-eod' LIMIT ?))<? END
    /* eod-yahoo-storage-admission */`)
    .bind(block.id, block.feed, block.ticker, block.calendarYear, block.schemaVersion, block.codec, block.checksum,
      block.rowCount, block.firstDate, block.lastDate, block.uncompressedBytes, block.payloadBase64,
      block.ticker, EOD_YAHOO_ARCHIVE_TICKER_LIMIT, EOD_YAHOO_ARCHIVE_TICKER_LIMIT).run();
  if (!result.meta.changes && !await db.prepare("SELECT 1 AS present FROM market_history_blocks WHERE id=?").bind(block.id).first()) {
    throw new EodFallbackStorageFullError();
  }
  return { rowsRead: Number(result.meta.rows_read ?? 0) + 1, rowsWritten: Number(result.meta.rows_written ?? result.meta.changes ?? 0) };
}
