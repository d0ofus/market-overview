import { storageHash } from "../src/market-storage-pages";
import { storageMigrationIdentity, type StorageMigrationRun } from "../src/market-storage-control";
import { prepareStorageSourceFence } from "../src/market-storage-fence";
import { assertStorageVerificationCapture, inspectStorageHistoryPointerIndexSchema,
  type StorageHistoryPointerIndexAmendment } from "../src/market-storage-verification";
import { validateStorageConsumerEvidence, type StorageAcceptanceCapture, type StorageConsumerCheckpoint,
  type StorageConsumerEvidence } from "../src/market-storage-acceptance";
import { verifyStorageExpansionBaseline, verifyStoragePopulationDelta } from "../src/market-storage-population-expansion";
import type { StoragePopulationPlan } from "../src/market-storage-population-plan";
import type { Env } from "../src/types";

const digest = /^[a-f0-9]{64}$/;
function fail(reason: string): never { throw new Error(`storage-expansion-operator-${reason}`); }
const same = async (left: unknown, right: unknown) => await storageHash(left) === await storageHash(right);
// Quoted values are semantic. A changed trigger literal must not normalize away.
function sqlTokens(sql: string): string {
  const input = sql.trim().replace(/^CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\s+/i, "CREATE TRIGGER ");
  let output = "", quote: string | null = null;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      output += char;
      if (char === quote) { if (input[index + 1] === quote) output += input[++index]; else quote = null; }
    } else if (["'", '"', "`", "["].includes(char)) { quote = char === "[" ? "]" : char; output += char; }
    else if (!/\s/.test(char)) output += char;
  }
  if (quote) fail("guard-invalid");
  return output.replace(/;$/, "");
}

/** Observe the already-open target/history without releasing or freezing either.
 * Source evidence stays at the original immutable capture; current revisions
 * bind this separate delta proof. Every call rechecks schema and tracking. */
export async function captureStoragePopulationDelta(input: {
  source: D1Database; target: D1Database; history: D1Database; run: StorageMigrationRun;
  previousPlan: StoragePopulationPlan; amendment: StorageHistoryPointerIndexAmendment;
}): Promise<{ capture: StorageAcceptanceCapture; inputClock: number }> {
  const identity = storageMigrationIdentity(input.run), original = input.previousPlan.capture;
  await assertStorageVerificationCapture(input.source, identity, original.sourceCapture);
  const state = () => input.target.prepare(`SELECT f.status,f.revision,f.migration_id,f.code_revision,f.schema_hash,
    f.snapshot_revision,f.released_at,c.revision AS inputClock FROM market_storage_fence f
    JOIN eod_input_clock c ON c.id='default' WHERE f.id='default'`).first<{
      status: string; revision: number; migration_id: string; code_revision: string; schema_hash: string;
      snapshot_revision: number; released_at: string | null; inputClock: number;
    }>();
  const before = await state(), plan = await prepareStorageSourceFence(input.target);
  if (!before || before.status !== "open" || before.migration_id !== identity.id || before.code_revision !== identity.codeRevision
    || before.schema_hash !== original.targetCapture.schemaHash || before.snapshot_revision !== original.targetCapture.revision
    || before.released_at !== null || plan.schemaHash !== original.targetCapture.schemaHash
    || !Number.isSafeInteger(before.revision) || before.revision < original.targetCapture.revision
    || !Number.isSafeInteger(before.inputClock) || before.inputClock < 0) fail("target-capture-invalid");
  const guards = (await input.target.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name LIKE 'market_storage_guard_%'")
    .all<{ sql: string }>()).results;
  const expected = new Set(plan.statements.map(row => sqlTokens(row.sql)));
  if (guards.length !== expected.size || guards.some(row => !row.sql || !expected.has(sqlTokens(row.sql)))) fail("target-guards-changed");
  const history = await inspectStorageHistoryPointerIndexSchema(input.history, identity, original.historyCapture,
    { historyDatabaseId: identity.historyDatabaseId, policy: "indexed" });
  const amendment = input.amendment;
  if (history.schemaHash !== amendment.schemaHash || history.legacySchemaHash !== amendment.legacySchemaHash
    || history.indexManifestHash !== amendment.indexManifestHash || history.snapshotRevision !== amendment.snapshotRevision
    || history.revision < amendment.revision || amendment.historyDatabaseId !== identity.historyDatabaseId) fail("history-amendment-mismatch");
  if (!await same(before, await state())) fail("target-capture-changed");
  const fields = { identity, sourceCapture: original.sourceCapture,
    targetCapture: { schemaHash: plan.schemaHash, revision: before.revision },
    historyCapture: { schemaHash: history.schemaHash, revision: history.revision } };
  return { capture: { ...fields, captureHash: await storageHash(fields) }, inputClock: before.inputClock };
}

type DeltaPage = { version: 1; selectionHash: string; captureHash: string; previousHash: string | null;
  checkpoint: StorageConsumerCheckpoint; evidence: StorageConsumerEvidence | null; recordHash: string };
const deltaKey = (id: string, selection: string, capture: string, page: number) =>
  `storage-expansion-delta:${id}:${selection}:${capture}:${page}`;

/** Read-only reuse of a completed, independently dated delta proof. Missing
 * pages never start new reader work under a different executor identity. */
export async function loadCompletedStoragePopulationDelta(input: {
  ops: D1Database; migrationId: string; previousPlanHash: string; nextInputsHash: string;
  capture: StorageAcceptanceCapture; addedTickers: string[];
}): Promise<{ evidence: StorageConsumerEvidence; checkpoint: StorageConsumerCheckpoint;
  selectionHash: string; records: Array<{ id: string; payload: string }> }> {
  if (![input.previousPlanHash, input.nextInputsHash].every(value => digest.test(value))
    || input.addedTickers.length < 1 || input.addedTickers.length > 100
    || new Set(input.addedTickers).size !== input.addedTickers.length) fail("completed-selection-invalid");
  const selectionHash = await storageHash([input.previousPlanHash, input.nextInputsHash, [...input.addedTickers].sort()]);
  const records: Array<{ id: string; payload: string }> = [];
  let previous: DeltaPage | null = null;
  const pages = Math.ceil(input.addedTickers.length / 10);
  for (let page = 1; page <= pages; page++) {
    const id = deltaKey(input.migrationId, selectionHash, input.capture.captureHash, page);
    const payload = await input.ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(id).first<string>("evidence_json");
    if (!payload) fail("completed-delta-missing");
    let value: DeltaPage;
    try { value = JSON.parse(payload) as DeltaPage; } catch { fail("completed-delta-json-invalid"); }
    const { recordHash, ...fields } = value!;
    if (value!.version !== 1 || recordHash !== await storageHash(fields) || value!.selectionHash !== selectionHash
      || value!.captureHash !== input.capture.captureHash || value!.previousHash !== (previous?.recordHash ?? null)
      || value!.checkpoint.nextTicker !== Math.min(page * 10, input.addedTickers.length)
      || Boolean(value!.evidence) !== (page === pages)) fail("completed-delta-integrity");
    records.push({ id, payload }); previous = value!;
  }
  if (!previous?.evidence) fail("completed-delta-missing");
  await validateStorageConsumerEvidence(previous.evidence, input.capture, input.addedTickers);
  return { evidence: previous.evidence, checkpoint: previous.checkpoint, selectionHash, records };
}

export type StorageExpansionHistoryIdentity = { migrationId: string; codeRevision: string; previousPlanHash: string;
  nextInputsHash: string; captureHash: string; historyDatabaseId: string };
export type StorageExpansionHistoryReceipt = StorageExpansionHistoryIdentity & { version: 1; directory: string; file: string;
  rows: number; hash: string; fileHash: string; capturedAt: string; evidenceHash: string };
const historyReceiptKey = async (identity: StorageExpansionHistoryIdentity) => `storage-expansion-history:${await storageHash(identity)}`;
export async function loadStorageExpansionHistoryReceipt(ops: D1Database,
  identity: StorageExpansionHistoryIdentity): Promise<StorageExpansionHistoryReceipt | null> {
  const text = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
    .bind(await historyReceiptKey(identity)).first<string>("evidence_json");
  if (!text) return null;
  let receipt: StorageExpansionHistoryReceipt;
  try { receipt = JSON.parse(text) as StorageExpansionHistoryReceipt; } catch { fail("history-receipt-json-invalid"); }
  const { evidenceHash, ...fields } = receipt!;
  if (receipt!.version !== 1 || !digest.test(evidenceHash) || evidenceHash !== await storageHash(fields)
    || Object.entries(identity).some(([key, value]) => fields[key as keyof typeof fields] !== value)
    || !/^history-[1-4]\.sqlite$/.test(receipt!.file) || typeof receipt!.directory !== "string" || !receipt!.directory
    || !Number.isSafeInteger(receipt!.rows) || receipt!.rows <= 0 || !digest.test(receipt!.hash) || !digest.test(receipt!.fileHash)
    || !Number.isFinite(Date.parse(receipt!.capturedAt))) fail("history-receipt-integrity");
  return receipt!;
}
export async function storeStorageExpansionHistoryReceipt(ops: D1Database, identity: StorageExpansionHistoryIdentity,
  capture: Pick<StorageExpansionHistoryReceipt, "directory" | "file" | "rows" | "hash" | "fileHash" | "capturedAt">): Promise<StorageExpansionHistoryReceipt> {
  const fields = { version: 1 as const, ...identity, ...capture }, receipt = { ...fields, evidenceHash: await storageHash(fields) };
  await ops.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING")
    .bind(await historyReceiptKey(identity), JSON.stringify(receipt), capture.capturedAt).run();
  const stored = await loadStorageExpansionHistoryReceipt(ops, identity);
  if (!await same(stored, receipt)) fail("history-receipt-write-conflict");
  return stored!;
}

/** Only new immutable operator records are written. Completed old consumer,
 * bootstrap, publication, quota and migration records are never replaced. A
 * lost write response resumes the stored page with its original timestamp. */
export async function runStoragePopulationDeltaProof(input: {
  ops: D1Database; run: StorageMigrationRun; previousPlan: StoragePopulationPlan; nextInputsHash: string;
  sourceEnv: Env; targetEnv: Env; capture: StorageAcceptanceCapture; addedTickers: string[];
  assertCapture: () => Promise<void>; assertQuiescence: () => Promise<void>; maxPages?: number;
}): Promise<{ complete: boolean; checkpoint: StorageConsumerCheckpoint | null; evidence: StorageConsumerEvidence | null;
  selectionHash: string; pageCount: number }> {
  if (!digest.test(input.nextInputsHash) || !input.addedTickers.length || input.addedTickers.length > 100
    || new Set(input.addedTickers).size !== input.addedTickers.length
    || input.addedTickers.some(ticker => !/^[A-Z0-9][A-Z0-9.^=/-]{0,39}$/.test(ticker))) fail("selection-invalid");
  const maxPages = input.maxPages ?? 10;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) fail("page-bound-invalid");
  await input.assertQuiescence(); await input.assertCapture();
  await verifyStorageExpansionBaseline(input.ops, input.run, input.addedTickers);
  const selectionHash = await storageHash([input.previousPlan.planHash, input.nextInputsHash, [...input.addedTickers].sort()]);
  const totalPages = Math.ceil(input.addedTickers.length / 10);
  let previous: DeltaPage | null = null, pageCount = 0, executed = 0;
  for (let page = 1; page <= totalPages; page++) {
    const id = deltaKey(input.run.id, selectionHash, input.capture.captureHash, page);
    const read = () => input.ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(id).first<string>("evidence_json");
    const text = await read();
    if (text) {
      let stored: DeltaPage;
      try { stored = JSON.parse(text) as DeltaPage; } catch { fail("checkpoint-json-invalid"); }
      const { recordHash, ...fields } = stored!;
      if (stored!.version !== 1 || recordHash !== await storageHash(fields) || stored!.selectionHash !== selectionHash
        || stored!.captureHash !== input.capture.captureHash || stored!.previousHash !== (previous?.recordHash ?? null)
        || stored!.checkpoint.nextTicker !== Math.min(page * 10, input.addedTickers.length)
        || Boolean(stored!.evidence) !== (page === totalPages)) fail("checkpoint-integrity");
      previous = stored!; pageCount = page;
      continue;
    }
    if (executed >= maxPages) break;
    await input.assertQuiescence(); await input.assertCapture();
    const result = await verifyStoragePopulationDelta({ ops: input.ops, run: input.run, previousPlan: input.previousPlan,
      sourceEnv: input.sourceEnv, targetEnv: input.targetEnv, capture: input.capture, addedTickers: input.addedTickers,
      assertCapture: input.assertCapture, checkpoint: previous?.checkpoint, maxTickers: 10 });
    if (result.checkpoint.nextTicker !== Math.min(page * 10, input.addedTickers.length)) fail("checkpoint-progress-invalid");
    const fields = { version: 1 as const, selectionHash, captureHash: input.capture.captureHash,
      previousHash: previous?.recordHash ?? null, checkpoint: result.checkpoint, evidence: result.evidence };
    const record: DeltaPage = { ...fields, recordHash: await storageHash(fields) }, payload = JSON.stringify(record);
    await input.assertQuiescence(); await input.assertCapture();
    await input.ops.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING")
      .bind(id, payload, new Date().toISOString()).run();
    // An existing record with a different timestamp/hash is not overwritten.
    if (await read() !== payload) fail("checkpoint-write-conflict");
    previous = record; pageCount = page; executed++;
  }
  await input.assertQuiescence(); await input.assertCapture();
  if (previous?.evidence) await validateStorageConsumerEvidence(previous.evidence, input.capture, input.addedTickers);
  return { complete: Boolean(previous?.evidence), checkpoint: previous?.checkpoint ?? null,
    evidence: previous?.evidence ?? null, selectionHash, pageCount };
}
