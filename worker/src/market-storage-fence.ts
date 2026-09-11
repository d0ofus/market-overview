import { eodHash } from "./eod-publication-service";
import type { StorageMigrationIdentity } from "./market-storage-control";

type SchemaObject = {type:string;name:string;tableName:string;sql:string|null};
type Fence = {status:string;revision:number;migrationId:string|null;codeRevision:string|null;schemaHash:string|null;snapshotRevision:number|null};
export type StorageSourcePlan = {schemaHash:string;tables:string[];statements:Array<{sql:string;params:unknown[]}>};
const prefix="market_storage_guard_";
const tableIdentifier=/^[A-Za-z][A-Za-z0-9_]{0,100}$/;
function internal(name:string):boolean {
  return name.startsWith("sqlite_") || name.startsWith("_cf_") || name==="market_storage_fence" || name.startsWith(prefix);
}
const normalize=(sql:string) => sql.trim().replace(/;\s*$/," ").replace(/\bIF NOT EXISTS\b/ig,"").replace(/\s+/g," ").trim();
const schemaSql="SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
const fenceSql=`SELECT status,revision,migration_id AS migrationId,code_revision AS codeRevision,
    schema_hash AS schemaHash,snapshot_revision AS snapshotRevision FROM market_storage_fence WHERE id='default'`;
async function schema(source:D1Database):Promise<SchemaObject[]> {
  const result=await source.prepare(schemaSql)
    .all<SchemaObject>();
  if (result.results.length>1_000) throw new Error("storage-migration-schema-exceeds-bound");
  return result.results;
}
async function fence(source:D1Database):Promise<Fence> {
  const value=await source.prepare(fenceSql).first<Fence>();
  if (!value) throw new Error("storage-migration-fence-schema-required");
  return value;
}
function trigger(table:string,event:"INSERT"|"UPDATE"|"DELETE"):string {
  // D1's remote SQL splitter can mistake a bare CASE END; for the trigger's
  // closing END;. Parentheses preserve SQLite semantics and that boundary.
  // https://github.com/cloudflare/workers-sdk/issues/4727
  return `CREATE TRIGGER IF NOT EXISTS ${prefix}${table}_${event.toLowerCase()} BEFORE ${event} ON "${table}" BEGIN
    SELECT (CASE WHEN COALESCE((SELECT status FROM market_storage_fence WHERE id='default'),'frozen')='frozen'
      THEN RAISE(ABORT,'market-storage-source-frozen') END);
    UPDATE market_storage_fence SET revision=revision+1 WHERE id='default' AND released_at IS NULL;
  END;`;
}
/** Planning is read-only. The operator must install these complete statements
 * through reviewed D1 object batches; this helper never activates the fence. */
export async function prepareStorageSourceFence(source:D1Database):Promise<StorageSourcePlan> {
  await fence(source);
  const objects=await schema(source);
  return planFromSchema(objects);
}
/** Pure planning preserves the captured SQL bytes and canonical object order. */
async function planFromSchema(objects:SchemaObject[]):Promise<StorageSourcePlan> {
  if (objects.length>1_000) throw new Error("storage-migration-schema-exceeds-bound");
  const canonical=objects.filter((row) => !internal(row.name) && !internal(row.tableName));
  const tables=canonical.filter((row) => row.type==="table").map((row) => row.name).sort();
  if (!tables.length || tables.length>100 || tables.some((table) => !tableIdentifier.test(table))
    || canonical.some((row) => row.type==="table" && /CREATE VIRTUAL TABLE/i.test(row.sql ?? ""))) {
    throw new Error("storage-migration-source-schema-unsupported");
  }
  return {schemaHash:await eodHash(canonical.map((row) => [row.type,row.name,row.tableName,row.sql])),tables,
    statements:tables.flatMap((table) => (["INSERT","UPDATE","DELETE"] as const).map((event) => ({sql:trigger(table,event),params:[]})))};
}
async function verifiedPlan(source:D1Database,expectedSchemaHash:string):Promise<StorageSourcePlan> {
  const plan=await prepareStorageSourceFence(source);
  if (plan.schemaHash!==expectedSchemaHash) throw new Error("storage-migration-source-schema-changed");
  const objects=await schema(source);
  verifyGuards(plan,objects);
  return plan;
}
function verifyGuards(plan:StorageSourcePlan,objects:SchemaObject[]):void {
  const guards=objects.filter((row) => row.type==="trigger" && row.name.startsWith(prefix));
  const expected=new Set(plan.statements.map((statement) => normalize(statement.sql)));
  if (guards.length!==expected.size || guards.some((row) => !row.sql || !expected.has(normalize(row.sql)))) {
    throw new Error("storage-migration-source-fence-incomplete");
  }
}
/** Explicit freeze is durable across process exits, lease expiry and UTC resets.
 * All prior writes finish before this singleton update; later table DML aborts.
 * Schema changes require an operator and are rechecked at verification/cutover. */
export async function freezeStorageSource(source:D1Database,identity:StorageMigrationIdentity,expectedSchemaHash:string,now=new Date()):Promise<{schemaHash:string;revision:number}> {
  await verifiedPlan(source,expectedSchemaHash);
  const result=await source.prepare(`UPDATE market_storage_fence SET status='frozen',migration_id=?,code_revision=?,schema_hash=?,
    snapshot_revision=revision,frozen_at=?,released_at=NULL WHERE id='default' AND status='open'`)
    .bind(identity.id,identity.codeRevision,expectedSchemaHash,now.toISOString()).run();
  if (!result.meta.changes) return assertStorageSourceFrozen(source,identity,expectedSchemaHash);
  return assertStorageSourceFrozen(source,identity,expectedSchemaHash);
}
export async function assertStorageSourceFrozen(source:D1Database,identity:StorageMigrationIdentity,expectedSchemaHash:string):Promise<{schemaHash:string;revision:number}> {
  // D1 executes a batch transactionally: schema, every guard and the singleton
  // capture are from one read transaction, with one REST round trip. No state
  // is cached between caller batches. Freeze/release planning is unchanged.
  const results=await source.batch([source.prepare(schemaSql),source.prepare(fenceSql)]);
  if (results.length!==2) throw new Error("storage-migration-fence-read-incomplete");
  const states=results[1].results as Fence[];
  if (states.length!==1) throw new Error("storage-migration-fence-schema-required");
  const state=states[0],objects=results[0].results as SchemaObject[];
  const plan=await planFromSchema(objects);
  if (plan.schemaHash!==expectedSchemaHash) throw new Error("storage-migration-source-schema-changed");
  verifyGuards(plan,objects);
  if (state.status!=="frozen" || state.migrationId!==identity.id || state.codeRevision!==identity.codeRevision
    || state.schemaHash!==expectedSchemaHash || state.snapshotRevision!==state.revision
    || !Number.isSafeInteger(state.revision) || state.revision<0) throw new Error("storage-migration-source-capture-changed");
  return {schemaHash:expectedSchemaHash,revision:state.revision};
}
/** Abort/rollback only. The CLI must independently verify the source is still
 * the canonical binding and the replacement has never accepted new writes. */
export async function releaseStorageSourceFence(source:D1Database,identity:StorageMigrationIdentity,expectedSchemaHash:string,
  confirmation:{sourceStillCanonical:true;targetNeverActivated:true},now=new Date()):Promise<void> {
  if (confirmation.sourceStillCanonical!==true || confirmation.targetNeverActivated!==true) throw new Error("storage-migration-abort-canonical-proof-required");
  const existing=await fence(source);
  // A prior abort may have released the source before its Ops acknowledgement
  // reached the client. Replaying that acknowledgement must not refreeze it.
  if (existing.status==="open" && (existing.migrationId===null
    || (existing.migrationId===identity.id && existing.codeRevision===identity.codeRevision
      && existing.schemaHash===expectedSchemaHash))) return;
  await assertStorageSourceFrozen(source,identity,expectedSchemaHash);
  const result=await source.prepare(`UPDATE market_storage_fence SET status='open',released_at=?
    WHERE id='default' AND status='frozen' AND migration_id=? AND code_revision=? AND schema_hash=? AND revision=snapshot_revision`)
    .bind(now.toISOString(),identity.id,identity.codeRevision,expectedSchemaHash).run();
  if (!result.meta.changes) throw new Error("storage-migration-fence-release-conflict");
}

/** Target tables must be empty before the first checkpoint. Schema seed rows
 * are explicitly supplied from the reviewed target migration manifest. */
export async function assertStorageTargetEmpty(target:D1Database,tables:string[],expectedSeedRows:ReadonlyMap<string,ReadonlyArray<Record<string,unknown>>> = new Map()):Promise<void> {
  if (tables.length>100 || tables.some((table) => !tableIdentifier.test(table))) throw new Error("storage-migration-target-schema-unsupported");
  for (const table of tables) {
    if (internal(table)) continue;
    const seeds=expectedSeedRows.get(table);
    if (seeds) {
      if (seeds.length>20) throw new Error("storage-migration-target-seed-manifest-too-large");
      const rows=await target.prepare(`SELECT * FROM "${table}" LIMIT ?`).bind(seeds.length+1).all<Record<string,unknown>>();
      const identity=(values:ReadonlyArray<Record<string,unknown>>) => values.map((value) => JSON.stringify(
        Object.fromEntries(Object.entries(value).sort(([left],[right]) => left.localeCompare(right))))).sort();
      if (JSON.stringify(identity(rows.results))!==JSON.stringify(identity(seeds))) throw new Error("storage-migration-target-seed-mismatch");
      continue;
    }
    if (await target.prepare(`SELECT 1 AS present FROM "${table}" LIMIT 1`).first()) throw new Error("storage-migration-target-not-empty");
  }
}
