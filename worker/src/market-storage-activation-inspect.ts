import type { StorageMigrationIdentity } from "./market-storage-control";
import type { StorageServingState } from "./market-storage-activate-once";

export type StorageWorkerBinding = { name: string; type: string; id?: string; database_id?: string; text?: string; [key: string]: unknown };
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

/** Same immutable version API as the completion gate. A source version may
 * predate EOD_CODE_REVISION, but a target must identify the approved revision. */
export async function inspectStorageActivationDeployment(input: {
  accountId: string; token: string; workerName: string; identity: StorageMigrationIdentity;
  opsDatabaseId: string; fetcher?: typeof fetch;
}): Promise<StorageServingState & { bindings: StorageWorkerBinding[] }> {
  if (!/^[a-f0-9]{32}$/.test(input.accountId) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.workerName)) throw new Error("storage-activate-inspect-identity-invalid");
  const base = `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/workers/scripts/${input.workerName}`;
  const request = async (path: string) => {
    let response: Response;
    try { response = await (input.fetcher ?? fetch)(`${base}/${path}`, { headers: { Authorization: `Bearer ${input.token}` }, signal: AbortSignal.timeout(15_000) }); }
    catch { throw new Error("storage-activate-inspect-unavailable"); }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error("storage-activate-inspect-unavailable"); }
    let body: Record<string, unknown> | null;
    try { body = record(await response.json()); } catch { body = null; }
    if (body?.success !== true || (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length)) || !record(body.result)) {
      throw new Error("storage-activate-inspect-invalid-response");
    }
    return record(body.result)!;
  };
  const current = async () => {
    const response = await request("deployments"), first = Array.isArray(response.deployments) ? record(response.deployments[0]) : null;
    const version = Array.isArray(first?.versions) ? record(first.versions[0]) : null;
    if (!first || !uuid(first.id) || first.strategy !== "percentage" || !Array.isArray(first.versions) || first.versions.length !== 1
      || !uuid(version?.version_id) || version.percentage !== 100 || typeof first.created_on !== "string" || !Number.isFinite(Date.parse(first.created_on))) {
      throw new Error("storage-activate-inspect-nonexclusive-deployment");
    }
    return { deploymentId: first.id, versionId: version.version_id, createdAt: first.created_on };
  };
  const selected = await current(), detail = await request(`versions/${selected.versionId}`), bindings = record(detail.resources)?.bindings;
  if (detail.id !== selected.versionId || !Array.isArray(bindings) || bindings.some((row) => !record(row)
    || typeof record(row)?.name !== "string" || typeof record(row)?.type !== "string")
    || new Set(bindings.map((row) => record(row)!.name)).size !== bindings.length) throw new Error("storage-activate-inspect-bindings-invalid");
  const rows = bindings as StorageWorkerBinding[];
  const binding = (name: string, type: string) => { const row = rows.find((item) => item.name === name);
    if (!row || row.type !== type) throw new Error("storage-activate-inspect-binding-missing"); return row; };
  const database = (name: string) => { const row = binding(name, "d1");
    if (row.id && row.database_id && row.id !== row.database_id) throw new Error("storage-activate-inspect-database-conflict"); return row.id ?? row.database_id; };
  const variable = (name: string) => binding(name, "plain_text").text;
  const market = database("MARKET_DATA_DB"), side = market === input.identity.sourceDatabaseId ? "source" : "target";
  if (![input.identity.sourceDatabaseId, input.identity.targetDatabaseId].includes(market ?? "")
    || database("MARKET_HISTORY_DB") !== input.identity.historyDatabaseId || database("OPS_DB") !== input.opsDatabaseId
    || variable("EOD_STORAGE_MIGRATION_ID") !== input.identity.id || variable("EOD_ARCHIVE_PRUNE_ENABLED") !== "false"
    || variable("EOD_RUNNER_MODE") !== (side === "source" ? "shadow" : "active")
    || variable("EOD_READ_ENABLED") !== (side === "source" ? "false" : "true")
    || (side === "target" && variable("EOD_CODE_REVISION") !== input.identity.codeRevision)) throw new Error("storage-activate-inspect-serving-conflict");
  const confirmed = await current();
  if (JSON.stringify(selected) !== JSON.stringify(confirmed)) throw new Error("storage-activate-inspect-deployment-changed");
  return { ...selected, side, bindings: rows };
}
