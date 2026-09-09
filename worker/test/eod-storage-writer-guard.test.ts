import { afterEach,describe,expect,it } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { eodStorageWriterDisposition } from "../src/eod-storage-writer-guard";
import { createStorageMigration } from "../src/market-storage-control";
describe("already queued writers respect storage ownership",()=>{
  const databases:Array<ReturnType<typeof createSqliteD1>>=[];
  afterEach(()=>{for(const db of databases.splice(0))db.dispose();});
  it("blocks both source and private target during migration, then only the retired source",async()=>{
    const db=createSqliteD1();databases.push(db);db.migrate("ops-migrations");
    const identity={id:"market-storage:guard",sourceDatabaseId:"10000000-0000-4000-8000-000000000001",
      targetDatabaseId:"10000000-0000-4000-8000-000000000002",historyDatabaseId:"10000000-0000-4000-8000-000000000003",sessionDate:"2026-09-08",codeRevision:"a".repeat(40)};
    expect(await eodStorageWriterDisposition(db.db,identity.sourceDatabaseId)).toBe("canonical");
    await createStorageMigration(db.db,identity);
    expect(await eodStorageWriterDisposition(db.db,identity.sourceDatabaseId)).toBe("migration-in-progress");
    expect(await eodStorageWriterDisposition(db.db,identity.targetDatabaseId)).toBe("migration-in-progress");
    await db.db.prepare("UPDATE market_storage_migrations SET status='completed' WHERE id=?").bind(identity.id).run();
    expect(await eodStorageWriterDisposition(db.db,identity.sourceDatabaseId)).toBe("retired-source");
    expect(await eodStorageWriterDisposition(db.db,identity.targetDatabaseId)).toBe("canonical");
    await db.db.prepare("UPDATE market_storage_migrations SET status='aborted' WHERE id=?").bind(identity.id).run();
    expect(await eodStorageWriterDisposition(db.db,identity.sourceDatabaseId)).toBe("canonical");
  });
});
