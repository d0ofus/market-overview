/** Cloudflare's shared REST allowance is 1,200 requests per five minutes, even
 * when D1 row billing is Paid. Reserve headroom for other control-plane clients.
 * This limits request starts; it never retries an ambiguous database mutation. */
const REQUEST_INTERVAL_MS = Math.ceil(60_000 / 180);
const MAX_SERVER_COOLDOWN_MS = 5 * 60_000;
type Pacer = { nextAt:number; blockedUntil:number; queue:Promise<void> };

export function createEodRestRequestLimiter(options:{
  now?:()=>number;
  sleep?:(milliseconds:number)=>Promise<void>;
}={}) {
  const now=options.now ?? Date.now;
  const sleep=options.sleep ?? ((milliseconds:number) => new Promise<void>((resolve) => setTimeout(resolve,milliseconds)));
  const clients=new Map<string,Pacer>();
  return async (accountId:string,token:string,fetcher:typeof fetch,input:RequestInfo|URL,init?:RequestInit|(()=>RequestInit)):Promise<Response> => {
    // Tokens stay solely in process memory, as they already do in request
    // headers. A single map is shared by all raw-Ops and admitted DB adapters.
    const key=`${accountId}:${token}`;
    let state=clients.get(key);
    if (!state) {state={nextAt:0,blockedUntil:0,queue:Promise.resolve()};clients.set(key,state);}
    const prior=state.queue;
    let release!:()=>void;
    state.queue=new Promise<void>((resolve) => {release=resolve;});
    await prior;
    try {
      while (now()<Math.max(state.nextAt,state.blockedUntil)) {
        await sleep(Math.min(30_000,Math.max(state.nextAt,state.blockedUntil)-now()));
      }
      state.nextAt=now()+REQUEST_INTERVAL_MS;
    } finally {release();}
    // Construct AbortSignal.timeout only after pacing/cooldown has completed;
    // queue time is not an HTTP timeout or proof that the query was submitted.
    const response=await fetcher(input,typeof init==="function" ? init() : init);
    const timestamp=now();
    const cooldown=(seconds:number) => {
      if (Number.isFinite(seconds) && seconds>0) state.blockedUntil=Math.max(state.blockedUntil,
        timestamp+Math.min(MAX_SERVER_COOLDOWN_MS,Math.ceil(seconds*1_000)));
    };
    if (response.status===429) {
      const retryAfter=response.headers.get("retry-after");
      const seconds=retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter)
        : retryAfter ? (Date.parse(retryAfter)-timestamp)/1_000 : 300;
      cooldown(Number.isFinite(seconds) && seconds>0 ? seconds : 300);
    }
    for (const item of (response.headers.get("ratelimit") ?? "").split(",")) {
      const remaining=/(?:^|;)\s*r=(\d+)\b/.exec(item),reset=/(?:^|;)\s*t=(\d+)\b/.exec(item);
      if (!remaining || !reset) continue;
      const seconds=Number(reset[1]),count=Number(remaining[1]);
      if (!count) cooldown(seconds);
      else if (Number.isSafeInteger(count) && Number.isSafeInteger(seconds)) {
        // Respect tighter shared remaining capacity seen on successful replies.
        state.nextAt=Math.max(state.nextAt,timestamp+Math.min(MAX_SERVER_COOLDOWN_MS,Math.ceil(seconds*1_000/(count+1))));
      }
    }
    return response;
  };
}

export const pacedEodRestFetch = createEodRestRequestLimiter();
