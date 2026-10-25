import assert from "node:assert/strict";
import test from "node:test";
import { deleteSectorFocusNarrative } from "./api";

test("focus deletion uses the authenticated proxy and targets only the encoded entry ID", async (context) => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  context.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return Response.json({ ok: true, id: "focus/id" });
  });

  assert.deepEqual(await deleteSectorFocusNarrative("focus/id"), { ok: true, id: "focus/id" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/admin/proxy/api/sectors/focus-narratives/focus%2Fid");
  assert.equal(calls[0].init?.method, "DELETE");
  assert.equal(calls[0].init?.body, undefined);
  assert.equal(calls[0].init?.credentials, "same-origin");
});

test("focus deletion exposes request failures so the UI can restore the entry", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({ error: "Focus narrative not found." }, { status: 404 }));
  await assert.rejects(deleteSectorFocusNarrative("missing"), /404.*Focus narrative not found/);
});
