import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storageStartHistoryFenceSchemaMatches } from "../src/market-storage-start";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const reviewed = readFileSync("history-migrations/0002_market_storage_fence.sql", "utf8")
  .replace(/^--.*$/gm, "").split(";")[0]!.trim();

describe("history fence schema compatibility", () => {
  it.each(["", " /* storage-reviewed-ddl */"])("accepts SQLite's exact stored schema with suffix %j", async (suffix) => {
    const storage = createSqliteD1();
    try {
      await storage.db.prepare(reviewed + suffix).run();
      const row = await storage.db.prepare("SELECT sql FROM sqlite_schema WHERE name='market_storage_fence'").first<{ sql: string }>();
      expect(row).not.toBeNull();
      if (suffix) expect(row!.sql).toMatch(/\/\* storage-reviewed-ddl \*\/$/);
      else expect(row!.sql).not.toContain("storage-reviewed-ddl");
      expect(storageStartHistoryFenceSchemaMatches(row!.sql, reviewed)).toBe(true);
    } finally { storage.dispose(); }
  });

  it("allows formatting outside quoted values without weakening schema identity", () => {
    expect(storageStartHistoryFenceSchemaMatches(reviewed.replace(/\r?\n/g, "   ") + ";", reviewed)).toBe(true);
    for (const changed of [
      reviewed.replace("CHECK(revision>=0)", "CHECK(revision>=-1)"),
      reviewed.replace("DEFAULT 'open'", "DEFAULT 'frozen'"),
      reviewed.replace("'open'", "' open '"),
      reviewed.replace("DEFAULT 0", "DEFAULT 1"),
      reviewed.replace("released_at TEXT", "released_at INTEGER"),
      reviewed.replace(") STRICT, WITHOUT ROWID", ") WITHOUT ROWID"),
      reviewed + " /* different-comment */",
      reviewed + " /* storage-reviewed-ddl */ SELECT 1",
    ]) expect(storageStartHistoryFenceSchemaMatches(changed, reviewed)).toBe(false);
  });

  it("does not normalize accounting markers, keywords or whitespace inside literals", () => {
    const quoted = "CREATE TABLE market_storage_fence(value TEXT DEFAULT 'IF NOT EXISTS  /* storage-reviewed-ddl */')";
    expect(storageStartHistoryFenceSchemaMatches(quoted.replace("EXISTS  ", "EXISTS "), quoted)).toBe(false);
    expect(storageStartHistoryFenceSchemaMatches(quoted.replace("IF NOT EXISTS", ""), quoted)).toBe(false);
    expect(storageStartHistoryFenceSchemaMatches(quoted.replace("/* storage-reviewed-ddl */", ""), quoted)).toBe(false);
  });
});
