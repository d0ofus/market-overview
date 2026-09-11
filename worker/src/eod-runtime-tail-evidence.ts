import { z } from "zod";
import { eodHash } from "./eod-publication-service";
import { buildRuntimeEvidence, runtimeSummarySchema, summarizeRuntimeSamples, validateRuntimeEvidence,
  type RuntimeEvidence, type RuntimeEvidenceIdentity } from "./eod-runtime-evidence";
import { EOD_RUNTIME_COORDINATOR_PATH, EOD_RUNTIME_HTTP_PATHS } from "./eod-runtime-telemetry";

export const RUNTIME_TAIL_ROUTES = [EOD_RUNTIME_HTTP_PATHS[0], EOD_RUNTIME_HTTP_PATHS[0],
  EOD_RUNTIME_HTTP_PATHS[1], EOD_RUNTIME_HTTP_PATHS[1], EOD_RUNTIME_COORDINATOR_PATH] as const;
export const runtimeTailReceiptId = (id: RuntimeEvidenceIdentity): string => `eod-runtime-tail-receipt:${id.probeId}:${id.workerVersion}`;
export const runtimeTailAttemptId = (id: RuntimeEvidenceIdentity): string => `eod-runtime-tail-attempt:${id.probeId}:${id.workerVersion}`;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const tailRequestSchema = z.object({ route: z.string(), nonce: z.string().uuid() }).strict();
export type RuntimeTailAttempt = {
  version: 1; identity: RuntimeEvidenceIdentity; publicationHash: string; validationPlanHash: string;
  connectedAt: string; probeUntil: string; requests: Array<z.infer<typeof tailRequestSchema>>;
};
const attemptSchema = z.object({ version: z.literal(1), identity: z.record(z.unknown()), publicationHash: hash,
  validationPlanHash: hash, connectedAt: z.string().datetime(), probeUntil: z.string().datetime(),
  requests: z.array(tailRequestSchema).length(5) }).strict();
export type RuntimeTailSample = { sample: RuntimeEvidence["samples"][number]; nonce: string; eventTimestamp: number };

export function normalizeRuntimeRay(value: string | null | undefined): string {
  if (!value || !/^[a-f0-9]{16}(?:-[A-Z]{3})?$/i.test(value)) throw new Error("runtime-tail-request-correlation-missing");
  return value.split("-")[0].toLowerCase();
}

/** The raw TraceItem is inspected in memory only. No headers, log text, body,
 * exception contents, WebSocket URL or token enters the returned record. */
export function sanitizeRuntimeTailEvent(raw: unknown, identity: RuntimeEvidenceIdentity): RuntimeTailSample {
  const parsed = z.object({ scriptName: z.literal(identity.workerName), scriptVersion: z.object({ id: z.literal(identity.workerVersion) }),
    cpuTime: z.number().finite().nonnegative(), outcome: z.literal("ok"), truncated: z.literal(false),
    eventTimestamp: z.number().finite().nonnegative(), exceptions: z.array(z.unknown()).length(0),
    logs: z.array(z.object({ message: z.array(z.unknown()).max(50) })).max(1000),
    event: z.object({ request: z.object({ url: z.string(), method: z.string(), headers: z.record(z.string()) }),
      response: z.object({ status: z.literal(200) }) }),
  }).safeParse(raw);
  if (!parsed.success) throw new Error("runtime-tail-invocation-incomplete-or-failed");
  const row = parsed.data, headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(row.event.request.headers)) {
    const lower = name.toLowerCase();
    if (Object.hasOwn(headers, lower)) throw new Error("runtime-tail-request-header-ambiguous");
    headers[lower] = value;
  }
  const summaries = row.logs.flatMap(log => log.message.flatMap(message => {
    if (typeof message === "string") { try { message = JSON.parse(message); } catch { return []; } }
    const result = runtimeSummarySchema.safeParse(message); return result.success ? [result.data] : [];
  }));
  if (summaries.length !== 1 || summaries[0].probeId !== identity.probeId) throw new Error("runtime-tail-summary-ambiguous-or-missing");
  const summary = summaries[0], nonce = headers["x-eod-runtime-request-id"];
  if (!z.string().uuid().safeParse(nonce).success) throw new Error("runtime-tail-request-correlation-missing");
  let url: URL;
  try { url = new URL(row.event.request.url); } catch { throw new Error("runtime-tail-request-origin-invalid"); }
  if (url.protocol !== "https:" || !url.hostname.startsWith(identity.workerName + ".") || !url.hostname.endsWith(".workers.dev")
    || url.search || url.hash || url.username || url.password || url.pathname !== summary.route
    || row.event.request.method !== (summary.route === EOD_RUNTIME_COORDINATOR_PATH ? "POST" : "GET")) {
    throw new Error("runtime-tail-request-origin-invalid");
  }
  return { sample: { summary, requestId: normalizeRuntimeRay(headers["cf-ray"]), cpuTimeMs: row.cpuTime, outcome: "ok" },
    nonce, eventTimestamp: row.eventTimestamp };
}

async function validateAttempt(value: unknown, identity: RuntimeEvidenceIdentity): Promise<RuntimeTailAttempt> {
  const parsed = attemptSchema.parse(value);
  if (await eodHash(parsed.identity) !== await eodHash(identity) || new Set(parsed.requests.map(row => row.nonce)).size !== 5
    || parsed.requests.some((row, i) => row.route !== RUNTIME_TAIL_ROUTES[i])
    || Date.parse(parsed.probeUntil) <= Date.parse(parsed.connectedAt)) throw new Error("runtime-tail-attempt-identity-conflict");
  return parsed as RuntimeTailAttempt;
}

/** An existing attempt is never resumed with a fresh stream: lost events cannot
 * be reconstructed by silently repeating requests. Use a new candidate attempt. */
export async function claimRuntimeTailAttempt(ops: D1Database, attempt: RuntimeTailAttempt): Promise<void> {
  await validateAttempt(attempt, attempt.identity);
  const existing = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
    .bind(runtimeTailAttemptId(attempt.identity)).first();
  if (existing) throw new Error("runtime-tail-attempt-already-claimed-new-candidate-required");
  const counter = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
    .bind(`eod-runtime-counter:${attempt.identity.probeId}`).first();
  if (counter) throw new Error("runtime-tail-candidate-already-probed");
  const result = await ops.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(id) DO NOTHING RETURNING id`).bind(runtimeTailAttemptId(attempt.identity), JSON.stringify(attempt), attempt.connectedAt).all<{id: string}>();
  if (result.results.length !== 1) throw new Error("runtime-tail-attempt-already-claimed-new-candidate-required");
}

export async function buildRuntimeTailEvidence(input: { identity: RuntimeEvidenceIdentity; version: unknown; attempt: RuntimeTailAttempt;
  events: RuntimeTailSample[]; responses: Array<{ nonce: string; requestId: string }>;
  window: { from: number; to: number }; closedAt: string; collectedAt?: string }): Promise<RuntimeEvidence> {
  const attempt = await validateAttempt(input.attempt, input.identity);
  if (input.events.length !== 5 || input.responses.length !== 5
    || new Set(input.responses.map(row => row.nonce)).size !== 5 || new Set(input.events.map(row => row.nonce)).size !== 5) {
    throw new Error("runtime-tail-exact-five-invocations-required");
  }
  const samples = attempt.requests.map(request => {
    const event = input.events.find(row => row.nonce === request.nonce), response = input.responses.find(row => row.nonce === request.nonce);
    if (!event || !response || event.sample.summary.route !== request.route || event.sample.requestId !== normalizeRuntimeRay(response.requestId)
      || event.eventTimestamp < input.window.from || event.eventTimestamp > input.window.to) throw new Error("runtime-tail-response-correlation-mismatch");
    return event.sample;
  }).sort((a, b) => a.summary.sampleId.localeCompare(b.summary.sampleId));
  const version = await buildRuntimeEvidence(input.identity, input.version, [], input.window, true);
  const body = { schemaVersion: 1 as const, source: "cloudflare-workers-live-tail-receipt" as const, identity: input.identity,
    collectedAt: input.collectedAt ?? new Date().toISOString(), window: input.window, versionBindings: version.versionBindings,
    complete: true, unavailableReasons: [], samples, measurements: summarizeRuntimeSamples(samples),
    liveTail: { receiptId: runtimeTailReceiptId(input.identity), attemptHash: await eodHash(attempt),
      publicationHash: attempt.publicationHash, validationPlanHash: attempt.validationPlanHash,
      connectedAt: attempt.connectedAt, closedAt: input.closedAt, probeUntil: attempt.probeUntil } };
  return validateRuntimeEvidence({ ...body, evidenceHash: await eodHash(body) }, input.identity);
}

async function assertDurableSamples(ops: D1Database, evidence: RuntimeEvidence): Promise<void> {
  const id = evidence.identity, tail = evidence.liveTail!;
  const counter = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
    .bind(`eod-runtime-counter:${id.probeId}`).first<{ evidence_json: string }>();
  const expectedHash = await eodHash({ probeId: id.probeId, until: Date.parse(tail.probeUntil), codeRevision: id.codeRevision,
    workerVersion: id.workerVersion, targetDatabaseId: id.targetDatabaseId });
  const value = counter ? JSON.parse(counter.evidence_json) as { claimed?: number; configurationHash?: string } : null;
  if (value?.claimed !== 5 || value.configurationHash !== expectedHash) throw new Error("runtime-tail-counter-incomplete-or-conflicting");
  const persisted = await ops.batch(evidence.samples.map(sample => ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
    .bind(`eod-runtime:${id.probeId}:${sample.summary.sampleId}`)));
  for (let index = 0; index < evidence.samples.length; index++) {
    const result = persisted[index].results as Array<{ evidence_json: string }>;
    const row = result.length === 1 ? JSON.parse(result[0].evidence_json) as Record<string, unknown> : null;
    const summary = evidence.samples[index].summary;
    if (!row || row.measurementStage !== "before-final-control-settlement" || row.complete !== false
      || ["probeId", "sampleId", "category", "route", "codeRevision", "workerVersion", "targetDatabaseId", "startedAt", "outcome", "eodReadEnabled"]
        .some(key => row[key] !== summary[key as keyof typeof summary])) throw new Error("runtime-tail-durable-sample-mismatch");
  }
}

/** Called only by the pinned authenticated streaming collector, never by an
 * operator JSON import command. Ops access and reviewed code are the trust root. */
export async function storeRuntimeTailReceipt(ops: D1Database, evidence: RuntimeEvidence): Promise<RuntimeEvidence> {
  await validateRuntimeEvidence(evidence, evidence.identity);
  if (evidence.source !== "cloudflare-workers-live-tail-receipt") throw new Error("runtime-tail-receipt-source-required");
  await assertDurableSamples(ops, evidence);
  await ops.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(runtimeTailReceiptId(evidence.identity), JSON.stringify(evidence), evidence.collectedAt).run();
  return loadRuntimeTailReceipt(ops, evidence.identity, { evidenceHash: evidence.evidenceHash,
    publicationHash: evidence.liveTail!.publicationHash, validationPlanHash: evidence.liveTail!.validationPlanHash });
}

export async function loadRuntimeTailReceipt(ops: D1Database, identity: RuntimeEvidenceIdentity, expected: {
  evidenceHash?: string; publicationHash: string; validationPlanHash: string;
}): Promise<RuntimeEvidence> {
  const rows = await ops.batch([runtimeTailReceiptId(identity), runtimeTailAttemptId(identity)].map(key =>
    ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(key)));
  const record = (index: number): unknown => {
    const found = rows[index].results as Array<{ evidence_json: string }>;
    if (found.length !== 1) throw new Error("runtime-tail-durable-receipt-missing"); return JSON.parse(found[0].evidence_json);
  };
  const evidence = await validateRuntimeEvidence(record(0), identity), attempt = await validateAttempt(record(1), identity);
  const tail = evidence.liveTail;
  if (evidence.source !== "cloudflare-workers-live-tail-receipt" || !tail || tail.receiptId !== runtimeTailReceiptId(identity)
    || tail.attemptHash !== await eodHash(attempt) || tail.connectedAt !== attempt.connectedAt || tail.probeUntil !== attempt.probeUntil
    || tail.publicationHash !== expected.publicationHash || tail.validationPlanHash !== expected.validationPlanHash
    || attempt.publicationHash !== expected.publicationHash || attempt.validationPlanHash !== expected.validationPlanHash
    || (expected.evidenceHash && evidence.evidenceHash !== expected.evidenceHash)) throw new Error("runtime-tail-receipt-identity-conflict");
  await assertDurableSamples(ops, evidence);
  return evidence;
}

/** Re-read the active deployment, not merely the latest uploaded settings. */
export async function verifyRuntimeLiveVersion(input: { accountId: string; token: string; identity: RuntimeEvidenceIdentity;
  fetcher?: typeof fetch }): Promise<unknown> {
  if (!/^[a-f0-9]{32}$/i.test(input.accountId) || !input.token) throw new Error("runtime-cloudflare-credentials-invalid");
  const call = async (suffix: string): Promise<Record<string, unknown>> => {
    const response = await (input.fetcher ?? fetch)(`https://api.cloudflare.com/client/v4/accounts/${input.accountId}/workers/scripts/${encodeURIComponent(input.identity.workerName)}/${suffix}`,
      { headers: { authorization: `Bearer ${input.token}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`runtime-cloudflare-http-${response.status}`); }
    const body = await response.json() as { success?: boolean; result?: Record<string, unknown> };
    if (!body.success || !body.result) throw new Error("runtime-cloudflare-response-invalid"); return body.result;
  };
  const current = await call("deployments");
  const parsed = z.object({ deployments: z.array(z.object({ versions: z.array(z.object({ version_id: z.string(), percentage: z.number() })) })).min(1) }).parse(current);
  const versions = parsed.deployments[0].versions;
  if (versions.length !== 1 || versions[0].percentage !== 100 || versions[0].version_id !== input.identity.workerVersion) throw new Error("runtime-tail-exclusive-version-changed");
  const version = await call(`versions/${input.identity.workerVersion}`);
  await buildRuntimeEvidence(input.identity, version, [], { from: Date.now() - 1000, to: Date.now() }, true);
  return version;
}
