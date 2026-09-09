import type { StorageMigrationIdentity } from "./market-storage-control";

type Binding = { name?: string; type?: string; id?: string; database_id?: string; text?: string };
type Deployment = { id: string; versionId: string; createdOn: string };
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const uuid = (value: unknown): value is string => typeof value === "string"
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export type StorageBindingEvidence = {
  version: 1; workerName: string; codeRevision: string; marketDatabaseId: string;
  historyDatabaseId: string; opsDatabaseId: string; observedAt: string;
  deploymentId: string; versionId: string;
};
/** Verify the version actually serving all traffic, not the latest upload or
 * script /settings. Re-read the deployment after its immutable version detail
 * so a concurrent deployment cannot certify a configuration no longer active.
 * API contracts:
 * https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
 * https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/ */
export async function verifyStoragePublicBindings(input: {
  accountId: string; token: string; workerName: string; identity: StorageMigrationIdentity;
  opsDatabaseId: string; githubMarketDatabaseId: string; githubRunnerMode: string; fetcher?: typeof fetch;
}): Promise<StorageBindingEvidence> {
  if (!/^[a-f0-9]{32}$/.test(input.accountId) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.workerName)) {
    throw new Error("storage-activation-worker-identity-invalid");
  }
  if (input.githubMarketDatabaseId !== input.identity.targetDatabaseId || input.githubRunnerMode !== "active") {
    throw new Error("storage-activation-github-bindings-mismatch");
  }
  if (![input.identity.sourceDatabaseId, input.identity.targetDatabaseId, input.identity.historyDatabaseId, input.opsDatabaseId].every(uuid)
    || input.identity.sourceDatabaseId === input.identity.targetDatabaseId || !/^[a-f0-9]{40}$/i.test(input.identity.codeRevision)
    || !input.identity.id) throw new Error("storage-activation-migration-identity-invalid");
  const base = `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/workers/scripts/${input.workerName}`;
  const request = async (path: string, category: "deployments" | "version"): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await (input.fetcher ?? fetch)(`${base}/${path}`,
        { headers: { Authorization: `Bearer ${input.token}` }, signal: AbortSignal.timeout(15_000) });
    } catch { throw new Error(`storage-activation-worker-${category}-unavailable`); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`storage-activation-worker-${category}-unavailable`);
    }
    let body: Record<string, unknown> | null;
    try { body = record(await response.json()); } catch { body = null; }
    const result = record(body?.result);
    if (body?.success !== true || !result || (body.errors !== undefined
      && (!Array.isArray(body.errors) || body.errors.length !== 0))) throw new Error(`storage-activation-worker-${category}-invalid`);
    return result;
  };
  const activeDeployment = async (): Promise<Deployment> => {
    const body = await request("deployments", "deployments");
    // Cloudflare documents the first entry as the active deployment. Do not
    // search older deployments for one that happens to match our desired state.
    const current = Array.isArray(body.deployments) ? record(body.deployments[0]) : null;
    if (!current || !uuid(current.id) || typeof current.created_on !== "string" || !Number.isFinite(Date.parse(current.created_on))
      || current.strategy !== "percentage" || !Array.isArray(current.versions)) throw new Error("storage-activation-active-deployment-invalid");
    const selected = record(current.versions[0]);
    if (current.versions.length !== 1 || !selected || selected.percentage !== 100 || !uuid(selected.version_id)) {
      throw new Error("storage-activation-deployment-not-exclusive");
    }
    return { id: current.id, versionId: selected.version_id, createdOn: current.created_on };
  };
  const deployment = await activeDeployment();
  const version = await request(`versions/${deployment.versionId}`, "version");
  const resources = record(version.resources);
  if (version.id !== deployment.versionId || !Array.isArray(resources?.bindings)
    || resources.bindings.some((binding) => record(binding) === null)) throw new Error("storage-activation-deployed-version-invalid");
  const bindings = resources.bindings as Binding[];
  const unique = (name: string, type: string) => {
    const matches = bindings.filter((binding) => binding.name === name);
    if (matches.length !== 1 || matches[0].type !== type) throw new Error("storage-activation-binding-missing-or-ambiguous");
    return matches[0];
  };
  const database = (name: string) => {
    const binding = unique(name, "d1");
    if (binding.id && binding.database_id && binding.id !== binding.database_id) throw new Error("storage-activation-binding-identity-conflict");
    return binding.id ?? binding.database_id;
  };
  const variable = (name: string) => unique(name, "plain_text").text;
  if (database("MARKET_DATA_DB") !== input.identity.targetDatabaseId
    || database("MARKET_HISTORY_DB") !== input.identity.historyDatabaseId || database("OPS_DB") !== input.opsDatabaseId
    || variable("EOD_RUNNER_MODE") !== "active" || variable("EOD_READ_ENABLED") !== "true"
    || variable("EOD_CODE_REVISION") !== input.identity.codeRevision
    || variable("EOD_STORAGE_MIGRATION_ID") !== input.identity.id) throw new Error("storage-activation-public-bindings-mismatch");
  const confirmed = await activeDeployment();
  if (confirmed.id !== deployment.id || confirmed.versionId !== deployment.versionId || confirmed.createdOn !== deployment.createdOn) {
    throw new Error("storage-activation-deployment-changed-during-verification");
  }
  return { version: 1, workerName: input.workerName, codeRevision: input.identity.codeRevision,
    marketDatabaseId: input.identity.targetDatabaseId, historyDatabaseId: input.identity.historyDatabaseId,
    opsDatabaseId: input.opsDatabaseId, observedAt: new Date().toISOString(), deploymentId: deployment.id, versionId: deployment.versionId };
}
