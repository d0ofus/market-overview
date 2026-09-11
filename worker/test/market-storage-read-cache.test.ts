import { describe, expect, it, vi } from "vitest";
import { createStorageCapturedReadCache } from "../src/market-storage-read-cache";

describe("per-capture exact reader reuse", () => {
  const database=(read:ReturnType<typeof vi.fn>) => ({prepare:(sql:string)=>({bind:(...params:unknown[])=>({
    all:()=>read(sql,params),
  })})}) as unknown as D1Database;
  const result=(value:string)=>({success:true,results:[{value}],meta:{rows_read:1,rows_written:0}});
  it("coalesces identical in-flight reads and keeps ranges/limits/databases distinct", async () => {
    const read=vi.fn(async()=>result("original")),raw=database(read),cache=createStorageCapturedReadCache(),db=cache(raw);
    expect(cache(raw)).toBe(db);
    const [first,second]=await Promise.all([db.prepare("SELECT value WHERE id=?").bind(1).all<{value:string}>(),
      db.prepare("SELECT value WHERE id=?").bind(1).all<{value:string}>()]);
    first.results[0].value="changed";
    expect(second.results[0].value).toBe("original");
    await db.prepare("SELECT value WHERE id=?").bind(2).all();
    await db.prepare("SELECT value WHERE id=? LIMIT ?").bind(1,520).all();
    await db.prepare("SELECT value WHERE id=? LIMIT ?").bind(1,1330).all();
    await cache(database(read)).prepare("SELECT value WHERE id=?").bind(1).all();
    expect(read).toHaveBeenCalledTimes(5);
  });
  it("re-reads beyond the memory bound and never shares a completed batch's cache", async () => {
    const read=vi.fn(async()=>result("long-value")),raw=database(read);
    const tiny=createStorageCapturedReadCache(1)(raw);
    await tiny.prepare("SELECT value").all();await tiny.prepare("SELECT value").all();
    expect(read).toHaveBeenCalledTimes(2);
    await createStorageCapturedReadCache()(raw).prepare("SELECT value").all();
    await createStorageCapturedReadCache()(raw).prepare("SELECT value").all();
    expect(read).toHaveBeenCalledTimes(4);
  });
  it("does not cache failures or permit mutations", async () => {
    const read=vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue(result("ok"));
    const db=createStorageCapturedReadCache()(database(read));
    await expect(db.prepare("SELECT value").all()).rejects.toThrow("network");
    await expect(db.prepare("SELECT value").all()).resolves.toMatchObject({results:[{value:"ok"}]});
    await expect(db.prepare("DELETE FROM values").all()).rejects.toThrow("mutation-forbidden");
    await expect(db.prepare("SELECT value").run()).rejects.toThrow("mutation-forbidden");
    expect(read).toHaveBeenCalledTimes(2);
  });
});
