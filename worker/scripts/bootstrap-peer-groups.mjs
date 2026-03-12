const apiBase = (process.env.PEER_GROUPS_API_BASE_URL || process.env.WORKER_API_BASE_URL || "").replace(/\/+$/, "");
const adminSecret = process.env.ADMIN_SECRET || process.env.NEXT_PUBLIC_ADMIN_SECRET || "";
const batchSize = Math.max(1, Math.min(100, Number(process.env.PEER_GROUPS_BATCH_SIZE || 25)));
const maxBatches = Math.max(1, Number(process.env.PEER_GROUPS_MAX_BATCHES || 20));
const pauseMs = Math.max(0, Number(process.env.PEER_GROUPS_BATCH_PAUSE_MS || 1500));
const retryCount = Math.max(0, Number(process.env.PEER_GROUPS_RETRY_COUNT || 3));
const retryPauseMs = Math.max(250, Number(process.env.PEER_GROUPS_RETRY_PAUSE_MS || 5000));
const providerMode = ["both", "finnhub", "fmp"].includes(process.env.PEER_GROUPS_PROVIDER_MODE || "")
  ? process.env.PEER_GROUPS_PROVIDER_MODE
  : "finnhub";
const enrichPeers = String(process.env.PEER_GROUPS_ENRICH_PEERS || "").toLowerCase() === "true";

if (!apiBase) {
  console.error("Missing PEER_GROUPS_API_BASE_URL or WORKER_API_BASE_URL.");
  process.exit(1);
}

if (!adminSecret) {
  console.error("Missing ADMIN_SECRET or NEXT_PUBLIC_ADMIN_SECRET.");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  let totalAttempted = 0;
  let totalSucceeded = 0;
  let totalFailed = 0;

  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
    let payload = null;
    let lastError = null;
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      try {
        const response = await fetch(`${apiBase}/api/admin/peer-groups/bootstrap`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminSecret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            limit: batchSize,
            onlyUnseeded: true,
            providerMode,
            enrichPeers,
          }),
        });

        payload = await response.json().catch(() => ({}));
        if (response.ok) {
          lastError = null;
          break;
        }
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }

      if (attempt < retryCount) {
        console.log(JSON.stringify({
          batch: batchIndex + 1,
          retry: attempt + 1,
          error: lastError instanceof Error ? lastError.message : String(lastError ?? "unknown"),
        }));
        await sleep(retryPauseMs);
      }
    }

    if (lastError) {
      console.error(`Batch ${batchIndex + 1} failed:`, payload ?? { error: lastError instanceof Error ? lastError.message : String(lastError ?? "unknown") });
      process.exit(1);
    }

    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const attempted = Number(payload.attempted || rows.length || 0);
    const succeeded = rows.filter((row) => row?.ok).length;
    const failed = rows.filter((row) => !row?.ok).length;
    totalAttempted += attempted;
    totalSucceeded += succeeded;
    totalFailed += failed;

    console.log(
      JSON.stringify({
        batch: batchIndex + 1,
        attempted,
        succeeded,
        failed,
        sample: rows.slice(0, 5).map((row) => ({
          ticker: row.ticker,
          ok: row.ok,
          inserted: Array.isArray(row.insertedTickers) ? row.insertedTickers.length : 0,
          error: row.error || null,
        })),
      }),
    );

    if (attempted === 0) break;
    if (batchIndex < maxBatches - 1 && pauseMs > 0) {
      await sleep(pauseMs);
    }
  }

  console.log(JSON.stringify({
    done: true,
    totalAttempted,
    totalSucceeded,
    totalFailed,
    providerMode,
    batchSize,
    maxBatches,
    retryCount,
  }));
}

await main();
