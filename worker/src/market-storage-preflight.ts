import { z } from "zod";
import { storageHash } from "./market-storage-pages";
import type { StorageMigrationIdentity } from "./market-storage-control";

const bytes = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const model = z.object({
  hotSessions: z.union([z.literal(260), z.literal(90)]), sweepHeadroomSessions: bytes.min(10),
  sharedTickers: bytes.positive(), modeledSipRows: bytes.positive(), fallbackTickerReserve: bytes.positive(),
  modeledFallbackRows: bytes.positive(), database: z.object({ physicalBytes: bytes.positive() }).passthrough(),
  publicationGrowthReserveBytes: bytes, projectedBytes: bytes.positive(), under350MB: z.boolean(),
}).passthrough();
const analysisSchema = z.object({
  version: z.literal(1), measuredAt: z.string().datetime({ offset: true }), sessionDate: z.string(),
  source: z.object({ snapshotSha256: digest, schemaSha256: digest,
    capture: z.object({ kind: z.literal("logical-d1-capacity-snapshot"), completeDeclared: z.literal(true),
      partialEstimate: z.literal(false) }).passthrough() }).passthrough(),
  population: z.object({ count: bytes.positive(), sha256: digest }).passthrough(),
  archive: z.object({ sourceRows: bytes.positive(), storageRoundTripPassed: z.literal(true),
    withAdditionalCompleteRevisionAndTransientBytes: bytes.positive() }).passthrough(),
  bootstrap: z.object({ recentRowsToInsert: bytes.positive(), nonPriceRowsPreserved: z.literal(true),
    database: z.object({ physicalBytes: bytes.positive() }).passthrough() }).passthrough(),
  retentionModels: z.array(model).length(2),
}).passthrough();

/** A relocation preflight is only a plan for a finite copy, never production
 * acceptance. Its conservative reserve must be replaced by measured publication
 * growth, consumer parity and actual live telemetry before public activation. */
export async function prepareStoragePreflight(input: {
  analysis: unknown; identity: StorageMigrationIdentity; tickers: string[];
  snapshotSource: { accountId: string; sourceDatabaseId: string; runId: string };
  accountId: string; sourceSchemaHash: string; now?: Date;
}) {
  const result = analysisSchema.safeParse(input.analysis);
  if (!result.success) throw new Error("storage-preflight-complete-analysis-required");
  const report = result.data, now = input.now ?? new Date();
  if (input.snapshotSource.accountId !== input.accountId
    || input.snapshotSource.sourceDatabaseId !== input.identity.sourceDatabaseId
    || !input.snapshotSource.runId.includes(`:${report.sessionDate}:`)
    || report.sessionDate !== input.identity.sessionDate
    || !/^[a-f0-9]{64}$/.test(input.sourceSchemaHash)) throw new Error("storage-preflight-identity-mismatch");
  const age = now.getTime() - Date.parse(report.measuredAt);
  if (age < 0 || age > 7 * 86_400_000) throw new Error("storage-preflight-measurement-expired");
  const tickers = [...input.tickers].sort();
  if (tickers.length !== report.population.count || new Set(tickers).size !== tickers.length
    || tickers.some((ticker) => !/^[A-Z0-9.^/_-]{1,32}$/.test(ticker))
    || await storageHash(tickers) !== report.population.sha256) throw new Error("storage-preflight-population-mismatch");
  if (new Set(report.retentionModels.map((item) => item.hotSessions)).size !== 2) {
    throw new Error("storage-preflight-retention-models-incomplete");
  }
  // 64 MB is explicit planning headroom, not a measured publication forecast.
  // Final acceptance independently requires real stored-payload growth evidence.
  const planningReserveBytes = 64_000_000;
  const eligible = report.retentionModels.filter((item) => item.sharedTickers === tickers.length
    && item.fallbackTickerReserve === tickers.length
    && item.modeledSipRows === tickers.length * (item.hotSessions + item.sweepHeadroomSessions)
    && item.modeledFallbackRows === item.modeledSipRows
    && item.projectedBytes === item.database.physicalBytes + item.publicationGrowthReserveBytes
    && item.database.physicalBytes + Math.max(planningReserveBytes, item.publicationGrowthReserveBytes) < 350_000_000)
    .sort((a, b) => b.hotSessions - a.hotSessions);
  if (!eligible.length || report.archive.withAdditionalCompleteRevisionAndTransientBytes >= 350_000_000
    || report.bootstrap.database.physicalBytes + planningReserveBytes >= 350_000_000) {
    throw new Error("storage-preflight-insufficient-headroom");
  }
  const evidence = { version: 1 as const, purpose: "relocation-preflight" as const, identity: input.identity,
    preparedAt: now.toISOString(), sourceSchemaHash: input.sourceSchemaHash,
    analysisHash: await storageHash(report), sourceSnapshotHash: report.source.snapshotSha256,
    tickerHash: report.population.sha256, tickerCount: tickers.length,
    hotSessions: eligible[0].hotSessions, sourcePriceRows: report.archive.sourceRows,
    bootstrapRows: report.bootstrap.recentRowsToInsert, bootstrapBytes: report.bootstrap.database.physicalBytes,
    projectedRecentBytes: eligible[0].database.physicalBytes + Math.max(planningReserveBytes, eligible[0].publicationGrowthReserveBytes),
    projectedArchiveBytes: report.archive.withAdditionalCompleteRevisionAndTransientBytes, planningReserveBytes,
    sourceCaptureComplete: false, productionAcceptance: false,
    remaining: ["frozen-source-copy", "independent-copy-verification", "full-consumer-parity", "private-target-bootstrap",
      "measured-publication-growth", "live-capacity-and-runtime", "public-binding-cutover"] };
  return { evidence, hash: await storageHash(evidence) };
}
