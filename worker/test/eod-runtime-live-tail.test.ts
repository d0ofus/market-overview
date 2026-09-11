import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openRuntimeLiveTail } from "../scripts/eod-runtime-live-tail";
import { tailFrame, tailIdentity, tailUuid } from "./helpers/runtime-tail-fixture";
const tailSessionId = tailUuid(88).replaceAll("-", "");

class Socket extends EventEmitter {
  readyState = 1;
  setup: unknown;
  pings = 0;
  send(data: string, options: unknown, callback: (error?: Error) => void): void { this.setup = { data: JSON.parse(data), options }; callback(); }
  ping(): void { this.pings++; queueMicrotask(() => this.emit("pong")); }
  close(): void { this.readyState = 3; queueMicrotask(() => this.emit("close", 1000)); }
  terminate(): void { this.close(); }
  frame(value: unknown): void { this.emit("message", Buffer.from(JSON.stringify(value))); }
}
function fixture() {
  const socket = new Socket();
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => Response.json({ success: true,
    result: init?.method === "POST" ? { id: tailSessionId, url: "wss://tail.developers.workers.dev/private-capability",
      expires_at: new Date(Date.now() + 3600_000).toISOString() } : { id: tailSessionId } }));
  type ConnectedSocket = ReturnType<NonNullable<Parameters<typeof openRuntimeLiveTail>[0]["socketFactory"]>>;
  const socketFactory = vi.fn(() => { setImmediate(() => socket.emit("open")); return socket as unknown as ConnectedSocket; });
  return { socket, input: { accountId: "a".repeat(32), token: "private-control-token", identity: tailIdentity, fetcher, socketFactory }, fetcher };
}
afterEach(() => vi.restoreAllMocks());
describe("authenticated live-tail transport", () => {
  it("opens with no sampling filter, completes setup/pong before callers can probe, and deletes the tail after five events", async () => {
    const { input, socket, fetcher } = fixture(), stream = await openRuntimeLiveTail(input);
    expect(socket.pings).toBe(1);
    expect(socket.setup).toEqual({ data: { debug: false }, options: { binary: false, compress: false, mask: false, fin: true } });
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ filters: [] });
    for (let i = 0; i < 5; i++) socket.frame(tailFrame(i));
    const samples = await stream.waitForFive(); expect(samples).toHaveLength(5);
    expect(JSON.stringify(samples)).not.toContain("private");
    const closed = await stream.close(); expect(await stream.close()).toBe(closed);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    expect(() => stream.assertHealthy()).toThrow("closed");
  });
  it.each(["sampling-notice", "duplicate", "missing-cpu", "disconnected", "exception"])("fails closed for %s and still cleans up", async kind => {
    const { input, socket, fetcher } = fixture(), stream = await openRuntimeLiveTail(input);
    try {
      if (kind === "sampling-notice") socket.frame({ message: "Some events have been dropped because of volume" });
      if (kind === "duplicate") { socket.frame(tailFrame()); socket.frame(tailFrame()); }
      if (kind === "missing-cpu") { const frame = tailFrame(); delete (frame as Partial<typeof frame>).cpuTime; socket.frame(frame); }
      if (kind === "disconnected") socket.emit("close", 1006);
      if (kind === "exception") socket.emit("error", new Error("private-websocket-address"));
      expect(() => stream.assertHealthy()).toThrow(/^runtime-tail-/);
      await expect(stream.waitForFive()).rejects.toThrow(/^runtime-tail-/);
    } finally { await stream.close(); }
    expect(fetcher.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
  });
  it("rejects 403 once without opening a socket or trying the restricted telemetry endpoint", async () => {
    const { input, fetcher } = fixture(); fetcher.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(openRuntimeLiveTail(input)).rejects.toThrow("http-403");
    expect(fetcher).toHaveBeenCalledOnce(); expect(input.socketFactory).not.toHaveBeenCalled();
  });
  it("deletes a created tail when its expiry is malformed", async () => {
    const { input, fetcher } = fixture(); fetcher.mockResolvedValueOnce(Response.json({ success: true,
      result: { id: tailSessionId, url: "wss://tail.developers.workers.dev/private-capability", expires_at: "invalid" } }));
    await expect(openRuntimeLiveTail(input)).rejects.toThrow("expiry-invalid");
    expect(input.socketFactory).not.toHaveBeenCalled(); expect(fetcher.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
  });
});
