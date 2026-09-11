import WebSocket from "ws";
import { sanitizeRuntimeTailEvent, type RuntimeTailSample } from "../src/eod-runtime-tail-evidence";
import type { RuntimeEvidenceIdentity } from "../src/eod-runtime-evidence";

type TailSocket = Pick<WebSocket, "on" | "once" | "send" | "ping" | "close" | "terminate" | "readyState">;
export type RuntimeTailStream = {
  connectedAt: string; assertHealthy(): void; waitForFive(): Promise<RuntimeTailSample[]>; close(): Promise<string>;
};

/** Node-only authenticated transport. Raw frames are never logged or written.
 * Opening a second stream cannot resume an interrupted collection attempt. */
export async function openRuntimeLiveTail(input: { accountId: string; token: string; identity: RuntimeEvidenceIdentity;
  fetcher?: typeof fetch; socketFactory?: (url: string) => TailSocket; timeoutMs?: number;
}): Promise<RuntimeTailStream> {
  if (!/^[a-f0-9]{32}$/i.test(input.accountId) || !input.token) throw new Error("runtime-cloudflare-credentials-invalid");
  const base = `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/workers/scripts/${encodeURIComponent(input.identity.workerName)}/tails`;
  const call = async (method: "POST" | "DELETE", id?: string): Promise<unknown> => {
    const response = await (input.fetcher ?? fetch)(base + (id ? `/${encodeURIComponent(id)}` : ""), {
      method, headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ filters: [] }) } : {}), redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`runtime-tail-control-http-${response.status}`); }
    const result = await response.json() as { success?: boolean; result?: unknown };
    if (!result.success) throw new Error("runtime-tail-control-response-invalid"); return result.result;
  };
  const created = await call("POST") as { id?: string; url?: string; expires_at?: string };
  // Start Tail returns a 32-character Cloudflare identifier, not a Worker
  // version UUID. Keep it private; it is used only for authenticated cleanup.
  if (!created?.id || !/^[a-f0-9]{32}$/i.test(created.id)) throw new Error("runtime-tail-session-id-invalid");
  let socket: TailSocket | undefined, interval: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  let closing = false, closedAt: string | undefined, failure: Error | null = null, awaitingPong = false;
  const samples: RuntimeTailSample[] = [];
  const fail = (reason: string): void => { failure ??= new Error(reason); };
  const assertHealthy = (): void => { if (failure) throw failure; if (closing) throw new Error("runtime-tail-session-closed"); };
  const close = async (): Promise<string> => {
    if (closedAt) return closedAt;
    closing = true; if (interval) clearInterval(interval); if (deadline) clearTimeout(deadline);
    if (socket) {
      const value = socket;
      await new Promise<void>(resolve => {
        if (value.readyState === WebSocket.CLOSED) { resolve(); return; }
        const timer = setTimeout(() => { value.terminate(); resolve(); }, 3000);
        value.once("close", () => { clearTimeout(timer); resolve(); }); value.close();
      });
    }
    await call("DELETE", created.id); closedAt = new Date().toISOString(); return closedAt;
  };
  try {
    const url = new URL(created.url ?? "");
    if (url.protocol !== "wss:" || url.username || url.password
      || !(url.hostname.endsWith(".workers.dev") || url.hostname.endsWith(".cloudflare.com"))
      || !created.expires_at || !Number.isFinite(Date.parse(created.expires_at))
      || Date.parse(created.expires_at) < Date.now() + 60_000) throw new Error("runtime-tail-session-url-or-expiry-invalid");
    socket = (input.socketFactory ?? (address => new WebSocket(address, "trace-v1", { maxPayload: 1_048_576, handshakeTimeout: 15_000 })))(url.toString());
    socket.on("error", () => fail("runtime-tail-stream-error"));
    socket.on("close", () => { if (!closing) fail("runtime-tail-stream-disconnected"); });
    socket.on("message", data => {
      if (closing) return;
      try {
        const frame = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        if (frame.byteLength > 1_048_576 || samples.length >= 5) throw new Error("runtime-tail-stream-extra-or-oversized-event");
        // Unknown control frames (including sampling/drop warnings) fail the
        // strict TraceItem contract rather than being silently ignored.
        const sample = sanitizeRuntimeTailEvent(JSON.parse(frame.toString("utf8")), input.identity);
        if (samples.some(row => row.nonce === sample.nonce || row.sample.requestId === sample.sample.requestId
          || row.sample.summary.sampleId === sample.sample.summary.sampleId)) throw new Error("runtime-tail-stream-duplicate-event");
        samples.push(sample);
      } catch (error) {
        fail(error instanceof Error && /^runtime-tail-[a-z-]+$/.test(error.message) ? error.message : "runtime-tail-stream-invalid-event");
      }
    });
    const value = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("runtime-tail-stream-open-timeout")), 15_000);
      value.once("error", () => { clearTimeout(timer); reject(new Error("runtime-tail-stream-open-failed")); });
      value.once("open", () => { clearTimeout(timer); resolve(); });
    });
    await new Promise<void>((resolve, reject) => value.send(JSON.stringify({ debug: false }),
      { binary: false, compress: false, mask: false, fin: true }, error => error ? reject(new Error("runtime-tail-stream-start-failed")) : resolve()));
    // A server pong proves the authenticated connection is live before any
    // sample is claimed or any probe HTTP request is sent.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("runtime-tail-stream-pong-timeout")), 10_000);
      value.once("pong", () => { clearTimeout(timer); resolve(); }); value.ping();
    });
    const connectedAt = new Date().toISOString();
    value.on("pong", () => { awaitingPong = false; });
    interval = setInterval(() => { if (awaitingPong) fail("runtime-tail-stream-heartbeat-lost"); awaitingPong = true; value.ping(); }, 10_000);
    deadline = setTimeout(() => fail("runtime-tail-stream-deadline-exceeded"), input.timeoutMs ?? 8 * 60_000);
    assertHealthy();
    return { connectedAt, assertHealthy, close, waitForFive: async () => {
      const until = Date.now() + 30_000;
      while (samples.length < 5 && Date.now() < until) { assertHealthy(); await new Promise(resolve => setTimeout(resolve, 50)); }
      assertHealthy(); if (samples.length !== 5) throw new Error("runtime-tail-stream-missing-events");
      await new Promise(resolve => setTimeout(resolve, 1000)); assertHealthy(); return structuredClone(samples);
    } };
  } catch (error) { await close(); throw error; }
}
