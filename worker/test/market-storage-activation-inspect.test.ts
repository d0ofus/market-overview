import { describe, expect, it, vi } from "vitest";
import { inspectStorageActivationDeployment } from "../src/market-storage-activation-inspect";
const identity = { id: "market-storage:test", sourceDatabaseId: "10000000-0000-4000-8000-000000000001",
  targetDatabaseId: "10000000-0000-4000-8000-000000000002", historyDatabaseId: "10000000-0000-4000-8000-000000000003",
  sessionDate: "2026-09-08", codeRevision: "a".repeat(40) };
const input = { accountId: "b".repeat(32), token: "secret-token", workerName: "market-command-worker", identity,
  opsDatabaseId: "10000000-0000-4000-8000-000000000004" };
const versionId = "10000000-0000-4000-8000-000000000005", deploymentId = "10000000-0000-4000-8000-000000000006";
const deployment = () => ({ id: deploymentId, created_on: "2026-09-09T00:00:00Z", strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }] });
const bindings = (side: "source" | "target") => [
  { name: "MARKET_DATA_DB", type: "d1", id: side === "source" ? identity.sourceDatabaseId : identity.targetDatabaseId },
  { name: "MARKET_HISTORY_DB", type: "d1", id: identity.historyDatabaseId }, { name: "OPS_DB", type: "d1", id: input.opsDatabaseId },
  ...Object.entries({ EOD_RUNNER_MODE: side === "source" ? "shadow" : "active", EOD_READ_ENABLED: side === "source" ? "false" : "true",
    EOD_ARCHIVE_PRUNE_ENABLED: "false", EOD_STORAGE_MIGRATION_ID: identity.id, ...(side === "target" ? { EOD_CODE_REVISION: identity.codeRevision } : {}) })
    .map(([name, text]) => ({ name, type: "plain_text", text })),
];
const envelope = (result: unknown) => Response.json({ success: true, result, errors: [] });
function fetcher(side: "source" | "target", rows = bindings(side)) {
  return vi.fn<typeof fetch>(async (url) => String(url).endsWith("/deployments") ? envelope({ deployments: [deployment()] })
    : envelope({ id: versionId, resources: { bindings: rows } }));
}
describe("activation source or target inspection", () => {
  it.each(["source", "target"] as const)("identifies the actual exclusive %s version", async (side) => {
    expect(await inspectStorageActivationDeployment({ ...input, fetcher: fetcher(side) })).toMatchObject({ side, versionId, deploymentId });
  });
  it("rejects ambiguous deployment rather than selecting an older matching upload", async () => {
    const mixed = { ...deployment(), versions: [{ version_id: versionId, percentage: 50 }, { version_id: identity.sourceDatabaseId, percentage: 50 }] };
    await expect(inspectStorageActivationDeployment({ ...input, fetcher: vi.fn<typeof fetch>(async () => envelope({ deployments: [mixed, deployment()] })) }))
      .rejects.toThrow("nonexclusive-deployment");
  });
  it("requires exact target code, disabled prune, storage ID and modes", async () => {
    for (const name of ["EOD_CODE_REVISION", "EOD_ARCHIVE_PRUNE_ENABLED", "EOD_STORAGE_MIGRATION_ID", "EOD_RUNNER_MODE", "EOD_READ_ENABLED"]) {
      const rows = bindings("target").map((row) => row.name === name ? { ...row, text: "wrong" } : row);
      await expect(inspectStorageActivationDeployment({ ...input, fetcher: fetcher("target", rows) })).rejects.toThrow("serving-conflict");
    }
  });
  it("rejects version movement and wrong source/history/Ops bindings", async () => {
    for (const name of ["MARKET_DATA_DB", "MARKET_HISTORY_DB", "OPS_DB"]) {
      const rows = bindings("source").map((row) => row.name === name ? { ...row, id: versionId } : row);
      await expect(inspectStorageActivationDeployment({ ...input, fetcher: fetcher("source", rows) })).rejects.toThrow("serving-conflict");
    }
    const changed = vi.fn<typeof fetch>().mockResolvedValueOnce(envelope({ deployments: [deployment()] }))
      .mockResolvedValueOnce(envelope({ id: versionId, resources: { bindings: bindings("source") } }))
      .mockResolvedValueOnce(envelope({ deployments: [{ ...deployment(), id: identity.targetDatabaseId }] }));
    await expect(inspectStorageActivationDeployment({ ...input, fetcher: changed })).rejects.toThrow("deployment-changed");
  });
  it("sanitizes authentication failure", async () => {
    const denied = vi.fn<typeof fetch>(async () => new Response("secret-token", { status: 403 }));
    await expect(inspectStorageActivationDeployment({ ...input, fetcher: denied })).rejects.toThrow("inspect-unavailable");
  });
});
