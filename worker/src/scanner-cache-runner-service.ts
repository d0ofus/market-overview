import { advanceScannerCacheScanRuns } from "./scans-page-service";
import type { Env, ScannerCacheScanQueueWakeUp } from "./types";

const MAX_RETRY_DELAY_SECONDS = 300;

export function parseScannerCacheWakeUp(value: unknown): ScannerCacheScanQueueWakeUp | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.version !== 1 || typeof message.runId !== "string" || !message.runId.trim()) return null;
  if (message.runType !== "relative-strength" && message.runType !== "vcp") return null;
  return { version: 1, runId: message.runId, runType: message.runType };
}

export async function consumeScannerCacheWakeUps(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const wakeUp = parseScannerCacheWakeUp(message.body);
    if (!wakeUp) {
      console.warn("discarding invalid scanner cache queue wake-up");
      message.ack();
      continue;
    }
    if (String(env.SCANNER_CACHE_QUEUE_ENABLED ?? "").trim().toLowerCase() !== "true" || !env.SCANNER_CACHE_DB) {
      message.ack();
      continue;
    }
    try {
      const result = await advanceScannerCacheScanRuns(env, { runId: wakeUp.runId, maxRuns: 1 });
      if (result.errors.length > 0) {
        const attempts = Math.max(1, Number(message.attempts ?? 1));
        message.retry({ delaySeconds: Math.min(MAX_RETRY_DELAY_SECONDS, 5 * (2 ** (attempts - 1))) });
      } else {
        message.ack();
      }
    } catch (error) {
      console.warn("scanner cache queue wake-up failed", { runId: wakeUp.runId, error });
      const attempts = Math.max(1, Number(message.attempts ?? 1));
      message.retry({ delaySeconds: Math.min(MAX_RETRY_DELAY_SECONDS, 5 * (2 ** (attempts - 1))) });
    }
  }
}

export async function reconcileScannerCacheRuns(
  env: Env,
  options: { maxBatches: number; timeBudgetMs: number; batchSize: number },
): Promise<void> {
  const queueEnabled = String(env.SCANNER_CACHE_QUEUE_ENABLED ?? "").trim().toLowerCase() === "true"
    && Boolean(env.SCANNER_CACHE_SCAN_QUEUE);
  const maxBatches = queueEnabled ? 1 : Math.max(1, Math.trunc(options.maxBatches));
  const startedAt = Date.now();
  for (let batch = 0; batch < maxBatches && Date.now() - startedAt < options.timeBudgetMs; batch += 1) {
    const remainingMs = Math.max(1_000, options.timeBudgetMs - (Date.now() - startedAt));
    const result = await advanceScannerCacheScanRuns(env, {
      maxRuns: 1,
      batchSize: options.batchSize,
      timeBudgetMs: remainingMs,
    });
    if (!result.hasMore) break;
  }
}
