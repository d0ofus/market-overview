import { describe, expect, it, vi } from "vitest";
import { createEodRestRequestLimiter } from "../src/eod-rest-request-limiter";

describe("shared D1 REST request pacing", () => {
  function fixture() {
    let time=1_000;
    const waits:number[]=[];
    const limiter=createEodRestRequestLimiter({now:()=>time,sleep:async(ms)=>{waits.push(ms);time+=ms;}});
    return {limiter,waits,now:()=>time};
  }
  it("paces starts across independent databases using the same account credential", async () => {
    const f=fixture(),starts:number[]=[];
    const fetcher=vi.fn(async()=>{starts.push(f.now());return new Response("ok");}) as typeof fetch;
    await Promise.all(Array.from({length:4},(_,index)=>f.limiter("account","token",fetcher,`https://example.test/${index}`)));
    expect(starts).toEqual([1_000,1_334,1_668,2_002]);
  });
  it("honors server cooldown in bounded waits without replaying the failed mutation", async () => {
    const f=fixture();
    const fetcher=vi.fn().mockResolvedValueOnce(new Response("limited",{status:429,headers:{"retry-after":"120"}}))
      .mockResolvedValue(new Response("ok"));
    expect((await f.limiter("account","token",fetcher,"https://example.test/",{method:"POST",body:"mutation"})).status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await f.limiter("account","token",fetcher,"https://example.test/");
    expect(f.now()).toBe(121_000);
    expect(f.waits).toEqual([30_000,30_000,30_000,30_000]);
  });
  it("slows requests when successful replies expose depleted shared capacity", async () => {
    const f=fixture(),fetcher=vi.fn().mockResolvedValue(new Response("ok",{headers:{ratelimit:'"default";r=1;t=30'}}));
    await f.limiter("account","token",fetcher,"https://example.test/");
    await f.limiter("account","token",fetcher,"https://example.test/");
    expect(f.now()).toBe(16_000);
  });
  it("keeps network errors ambiguous and releases the request queue", async () => {
    const f=fixture(),fetcher=vi.fn().mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(new Response("ok"));
    await expect(f.limiter("account","token",fetcher,"https://example.test/")).rejects.toThrow("network");
    await f.limiter("account","token",fetcher,"https://example.test/");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(f.now()).toBe(1_334);
  });
});
