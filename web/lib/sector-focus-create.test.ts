import assert from "node:assert/strict";
import test from "node:test";
import { createSectorFocusNarrative, updateSectorFocusNarratives } from "./api";

const entry = {
  sectorName: "Genomics",
  sourceNarrativeName: null,
  sourcePeerGroupId: "pg-genomics",
  manualName: "Genomics",
  selectedTickers: ["ABSI", "ADPT", "CAI", "CDNA", "GH", "LLY", "NRIX", "NTRA", "TWST", "VCYT"],
  comment: "Genomics",
};

test("focus creation posts only the new entry through the authenticated proxy", async (context) => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const saved = { ...entry, id: "server-id", sortOrder: 10, selectedTickers: entry.selectedTickers.map((ticker) => ({ ticker, name: ticker })) };
  context.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return Response.json({ row: saved }, { status: 201 });
  });
  const value = { ...entry, id: "client-id" };
  assert.deepEqual(await createSectorFocusNarrative(value), { row: saved });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/admin/proxy/api/sectors/focus-narratives");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.credentials, "same-origin");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), entry);
});

test("focus creation exposes validation failures to preserve the editor's input", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({ error: "Duplicate entry." }, { status: 409 }));
  await assert.rejects(createSectorFocusNarrative(entry), /409.*Duplicate entry/);
});

test("bulk saves for edits, comments, and reorder retain their existing PUT contract", async (context) => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  context.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return Response.json({ rows: [] });
  });
  const values = [{ ...entry, id: "existing-id", comment: "Updated comment" }];
  await updateSectorFocusNarratives(values);
  assert.equal(calls[0].path, "/api/admin/proxy/api/sectors/focus-narratives");
  assert.equal(calls[0].init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { focusNarratives: values });
});
