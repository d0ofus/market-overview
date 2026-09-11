import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EodPriceProvider, yahooEodSymbol, yahooWindowMatchesAlpaca, type EodPriceBar } from "../src/eod-price-provider";
import { meteredFetch,ProviderBudgetExceededError } from "../src/provider-usage";
import type { Env } from "../src/types";

vi.mock("../src/provider-usage", async (original) => ({...await original<typeof import("../src/provider-usage")>(),meteredFetch:vi.fn()}));
const request = vi.mocked(meteredFetch);
const env = { ALPACA_API_KEY: "test-key", ALPACA_API_SECRET: "test-secret" } as Env;
const price = (timestamp = "2026-09-08T04:00:00Z", close = 100) => ({ t: timestamp, o: close, h: close + 1, l: close - 1, c: close, v: 1000 });
const page = (bars: Record<string, ReturnType<typeof price>[]>, next_page_token?: string | null) => Response.json({ bars, next_page_token });

async function complete<T>(pending: Promise<T>): Promise<T> {
  // Attach rejection handling before advancing fake retry/body-timeout timers.
  const result = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  const settled = await result;
  if ("error" in settled) throw settled.error;
  return settled.value;
}

function yahooPayload(meta: Record<string, unknown>, dates = ["2026-09-04T13:30:00Z", "2026-09-08T13:30:00Z"]) {
  return Response.json({ chart: { result: [{
    meta: { symbol: "AAA", exchangeTimezoneName: "America/New_York", instrumentType: "EQUITY", currency: "USD", ...meta },
    timestamp: dates.map((date) => Date.parse(date) / 1000),
    indicators: { quote: [{ open: dates.map(() => 100), high: dates.map(() => 101), low: dates.map(() => 99),
      close: dates.map(() => 100), volume: dates.map(() => 999) }] },
  }], error: null } });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T23:00:00Z"));
  request.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("EOD Alpaca provider boundaries and isolation", () => {
  it("keeps liquidated funds out of current requests while retaining the configured identity", async () => {
    request.mockResolvedValueOnce(page({ AAA: [price()] }));
    const provider = new EodPriceProvider(env);
    expect((await complete(provider.alpaca(["EATZ", "AAA"], "2026-09-01", "2026-09-08"))).map(bar => bar.ticker)).toEqual(["AAA"]);
    expect(new URL(String(request.mock.calls[0]![1])).searchParams.get("symbols")).toBe("AAA");
    expect(provider.symbolErrors.get("EATZ")).toBe("fund-liquidated:last-trading-session-2026-04-30");
    request.mockClear();
    await expect(complete(provider.yahoo("EATZ", "2026-09-01", "2026-09-08", []))).rejects.toThrow("fund-liquidated");
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves historical liquidated-fund bars and rejects observations beyond the final session", async () => {
    request.mockResolvedValueOnce(page({ EATZ: [price("2026-04-30T04:00:00Z"), price()] }));
    const bars = await complete(new EodPriceProvider(env).alpaca(["EATZ"], "2026-04-29", "2026-09-08"));
    expect(bars.map(bar => bar.date)).toEqual(["2026-04-30"]);
  });

  it("allows historical Yahoo repair through a liquidated fund's actual final session", async () => {
    request.mockResolvedValueOnce(yahooPayload({symbol:"EATZ",instrumentType:"ETF"}, ["2026-04-29T13:30:00Z","2026-04-30T13:30:00Z"]));
    const overlap = ["2026-04-29","2026-04-30"].map(date => ({ticker:"EATZ",date,o:100,h:101,l:99,c:100,volume:1000,reportedVolume:1000,
      feed:"sip",sourceProvider:"alpaca",adjustment:"split",observedAt:"2026-05-01T00:00:00Z",fetchedAt:"2026-05-01T00:00:00Z"}));
    const bars = await complete(new EodPriceProvider(env).yahoo("EATZ","2026-04-29","2026-09-08",overlap));
    expect(bars.map(bar => bar.date)).toEqual(["2026-04-29","2026-04-30"]);
  });

  it("includes the first EDT daily bar and excludes surrounding New York sessions", async () => {
    request.mockResolvedValueOnce(page({ AAA: [price("2026-09-08T03:59:59Z"), price(), price("2026-09-09T04:00:00Z")] }));
    const bars = await complete(new EodPriceProvider(env).alpaca(["AAA"], "2026-09-08", "2026-09-08"));
    expect(bars.map((bar) => bar.date)).toEqual(["2026-09-08"]);
    const params = new URL(String(request.mock.calls[0]![1])).searchParams;
    expect(params.get("start")).toBe("2026-09-08T00:00:00.000Z");
    expect(params.get("end")).toBe("2026-09-08T22:44:00.000Z");
    expect(params.get("asof")).toBe("2026-09-08");
    expect(bars[0]?.reportedVolume).toBeNull();
  });

  it("also accepts EST daily timestamps and preserves raw reported volume separately", async () => {
    request.mockResolvedValueOnce(page({ AAA: [price("2026-01-05T05:00:00Z")] }));
    const [bar] = await complete(new EodPriceProvider(env).alpaca(["AAA"], "2026-01-05", "2026-01-05", "raw"));
    expect(bar).toMatchObject({ date: "2026-01-05", reportedVolume: 1000, adjustment: "raw" });
  });

  it("follows a short first page until later symbols are returned", async () => {
    request.mockResolvedValueOnce(page({ AAA: [price()] }, "second"))
      .mockResolvedValueOnce(page({ BBB: [price()] }, null));
    const bars = await complete(new EodPriceProvider(env).alpaca(["AAA", "BBB"], "2026-09-08", "2026-09-08"));
    expect(bars.map((bar) => bar.ticker)).toEqual(["AAA", "BBB"]);
    expect(new URL(String(request.mock.calls[1]![1])).searchParams.get("page_token")).toBe("second");
  });

  it("does not return first-page data when a later page exhausts retries", async () => {
    request.mockResolvedValueOnce(page({ AAA: [price()] }, "second"))
      .mockImplementation(async () => new Response(null, { status: 503 }));
    await expect(complete(new EodPriceProvider(env).alpaca(["AAA", "BBB"], "2026-09-08", "2026-09-08"))).rejects.toThrow("alpaca-http-503");
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("rejects looping pagination and conflicting duplicated bars", async () => {
    request.mockResolvedValueOnce(page({ AAA: [price()] }, "same"))
      .mockResolvedValueOnce(page({ AAA: [price()] }, "same"));
    await expect(complete(new EodPriceProvider(env).alpaca(["AAA"], "2026-09-08", "2026-09-08"))).rejects.toThrow("alpaca-pagination-loop");
    request.mockReset().mockResolvedValueOnce(page({ AAA: [price()] }, "second"))
      .mockResolvedValueOnce(page({ AAA: [price(undefined, 200)] }));
    await expect(complete(new EodPriceProvider(env).alpaca(["AAA"], "2026-09-08", "2026-09-08"))).rejects.toThrow("alpaca-conflicting-duplicate-bar");
  });

  it("isolates one invalid symbol without discarding supported siblings", async () => {
    request.mockImplementation(async (_env, url) => {
      const symbols = new URL(String(url)).searchParams.get("symbols")!.split(",");
      return symbols.includes("BAD") ? Response.json({ message: "invalid symbol: BAD" }, { status: 400 })
        : page(Object.fromEntries(symbols.map((symbol) => [symbol, [price()]])));
    });
    const provider = new EodPriceProvider(env);
    const bars = await complete(provider.alpaca(["AAA", "BAD", "BBB"], "2026-09-08", "2026-09-08"));
    expect(bars.map((bar) => bar.ticker)).toEqual(["AAA", "BBB"]);
    expect(provider.symbolErrors.get("BAD")).toBe("alpaca-symbol-unsupported");
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("partitions configured indices out of stock-bar requests without substitute instruments", async () => {
    request.mockResolvedValueOnce(page({ SPY: [price()] }));
    const provider = new EodPriceProvider(env);
    await complete(provider.alpaca(["SPY", "INSR", "VIX"], "2026-09-08", "2026-09-08"));
    expect(new URL(String(request.mock.calls[0]![1])).searchParams.get("symbols")).toBe("SPY");
    expect(provider.symbolErrors.get("INSR")).toBe("alpaca-index-unsupported");
    expect(yahooEodSymbol("INSR")).toBe("^INSR");
    expect(yahooEodSymbol("SPY")).toBe("SPY");
  });

  it.each([{currency:"CAD"},{instrumentType:"FUTURE"},{symbol:"RENAMED"}])("rejects an incompatible equity identity %j",async (meta) => {
    request.mockResolvedValueOnce(yahooPayload(meta));
    await expect(complete(new EodPriceProvider(env).yahoo("AAA","2026-09-04","2026-09-08",[])))
      .rejects.toThrow("yahoo-instrument-identity-unverified");
  });

  it("pins historical symbol mapping to the requested session across renames",async () => {
    request.mockResolvedValueOnce(page({OLD:[price("2026-09-04T04:00:00Z")]}));
    await complete(new EodPriceProvider(env).alpaca(["OLD"],"2026-09-04","2026-09-04"));
    const url=new URL(String(request.mock.calls[0]![1]));
    expect(url.searchParams.get("asof")).toBe("2026-09-04");
    request.mockResolvedValueOnce(page({NEW:[price("2026-09-04T04:00:00Z")]}));
    await expect(complete(new EodPriceProvider(env).alpaca(["OLD"],"2026-09-04","2026-09-04")))
      .rejects.toThrow("alpaca-symbol-mismatch");
  });

  it.each([400, 401, 403])("does not retry or bisect generic HTTP%s failures", async (status) => {
    request.mockResolvedValueOnce(Response.json({ message: "invalid start parameter" }, { status }));
    const provider = new EodPriceProvider(env);
    await expect(complete(provider.alpaca(["AAA", "BBB"], "2026-09-08", "2026-09-08"))).rejects.toThrow(`alpaca-http-${status}`);
    expect(request).toHaveBeenCalledTimes(1);
    expect(provider.symbolErrors.size).toBe(0);
  });

  it("honors an HTTP-date429 retry and bounds timeout retries", async () => {
    request.mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "Tue, 08 Sep 2026 23:00:03 GMT" } }))
      .mockResolvedValueOnce(page({ AAA: [price()] }));
    const started = Date.now();
    await complete(new EodPriceProvider(env).alpaca(["AAA"], "2026-09-08", "2026-09-08"));
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
    request.mockReset().mockRejectedValue(new Error("provider-timeout"));
    await expect(complete(new EodPriceProvider(env).alpaca(["AAA"], "2026-09-08", "2026-09-08"))).rejects.toThrow("provider-timeout");
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.every((call) => call[4] === 20_000)).toBe(true);
  });

  it("defers long rate-limit cooldowns and does not retry exhausted budgets", async () => {
    request.mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "120" } }));
    await expect(complete(new EodPriceProvider(env).alpaca(["AAA"], "2026-09-08", "2026-09-08"))).rejects.toThrow("alpaca-cooldown-120s");
    expect(request).toHaveBeenCalledTimes(1);
    request.mockReset().mockRejectedValue(new Error("Provider Budget Exceeded"));
    await expect(complete(new EodPriceProvider(env).alpaca(["AAA"], "2026-09-08", "2026-09-08"))).rejects.toThrow("Provider Budget Exceeded");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds stalled body reads after the response headers have arrived", async () => {
    const response = page({ AAA: [price()] });
    vi.spyOn(response, "json").mockImplementation(() => new Promise(() => undefined));
    request.mockResolvedValueOnce(response);
    await expect(complete(new EodPriceProvider(env).alpaca(["AAA"], "2026-09-08", "2026-09-08"))).rejects.toThrow("alpaca-body-timeout");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("waits until the next UTC minute after Alpaca's local minute allowance is exhausted", async () => {
    vi.setSystemTime(new Date("2026-09-08T23:00:59.500Z"));
    const calledAt: string[] = [];
    request.mockImplementation(async () => {
      calledAt.push(new Date().toISOString());
      if (calledAt.length===1) throw new ProviderBudgetExceededError("alpaca",160,"minute");
      return page({AAA:[price()]});
    });
    const bars=await complete(new EodPriceProvider(env).alpaca(["AAA"],"2026-09-08","2026-09-08"));
    expect(bars).toHaveLength(1);
    expect(calledAt[0]).toBe("2026-09-08T23:00:59.500Z");
    expect(Date.parse(calledAt[1]!)).toBeGreaterThanOrEqual(Date.parse("2026-09-08T23:01:00.025Z"));
    expect(calledAt).toHaveLength(2);
  });

  it("bounds persistent minute-budget waits and immediately propagates daily exhaustion", async () => {
    const minuteError=new ProviderBudgetExceededError("alpaca",160,"minute");
    request.mockRejectedValue(minuteError);
    const started=Date.now();
    await expect(complete(new EodPriceProvider(env).alpaca(["AAA"],"2026-09-08","2026-09-08"))).rejects.toBe(minuteError);
    expect(request).toHaveBeenCalledTimes(3);
    expect(Date.now()-started).toBe(120_025);
    const dailyError=new ProviderBudgetExceededError("alpaca",10000,"day");
    request.mockReset().mockRejectedValue(dailyError);
    await expect(complete(new EodPriceProvider(env).alpaca(["AAA"],"2026-09-08","2026-09-08"))).rejects.toBe(dailyError);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("EOD Yahoo identity and price basis", () => {
  const sipOverlap=():EodPriceBar[] => ["2026-09-04","2026-09-08"].map((date) => ({
    ticker:"AAA",date,o:100,h:101,l:99,c:100,volume:1000,reportedVolume:1000,
    feed:"sip",sourceProvider:"alpaca",adjustment:"split",fetchedAt:null,observedAt:null,
  }));
  // Metadata and timestamps from the single admitted 2026-09-11 VIX identity
  // diagnostic. Numeric prices/volume below use the synthetic yahooPayload.
  const vixMetadata = { symbol: "^VIX", exchangeTimezoneName: "America/Chicago", instrumentType: "INDEX", currency: "USD",
    shortName: "CBOE Volatility Index", longName: "CBOE Volatility Index" };
  const vixTimestamps = ["2026-09-09T07:00:00.000Z", "2026-09-10T07:00:00.000Z"];

  it("accepts reviewed VIX Chicago metadata while retaining NY session dates and Yahoo volume provenance", async () => {
    vi.setSystemTime(new Date("2026-09-11T14:09:15Z"));
    const body = await yahooPayload(vixMetadata, vixTimestamps).json() as { chart: { result: Array<{
      indicators: { adjclose?: Array<{ adjclose: number[] }> };
    }> } };
    body.chart.result[0]!.indicators.adjclose = [{ adjclose: [50, 50] }];
    request.mockResolvedValueOnce(Response.json(body));
    const bars = await complete(new EodPriceProvider(env).yahoo("VIX", "2026-09-09", "2026-09-10", []));
    expect(bars.map((bar) => ({ ticker: bar.ticker, date: bar.date, close: bar.c, volume: bar.volume,
      reportedVolume: bar.reportedVolume, sourceProvider: bar.sourceProvider, feed: bar.feed, adjustment: bar.adjustment }))).toEqual(
      ["2026-09-09", "2026-09-10"].map((date) => ({ ticker: "VIX", date, close: 100, volume: 999,
        reportedVolume: null, sourceProvider: "yahoo", feed: "yahoo-eod", adjustment: "split" })),
    );
    expect(decodeURIComponent(new URL(String(request.mock.calls[0]![1])).pathname)).toBe("/v8/finance/chart/^VIX");
  });

  it.each([
    { exchangeTimezoneName: "America/New_York" },
    { exchangeTimezoneName: "Europe/Oslo" },
    { symbol: "^VVIX" },
    { instrumentType: "ETF" },
    { currency: "CAD" },
    { shortName: "Different index", longName: "Different index" },
  ])("rejects incompatible VIX metadata despite the mapped Chicago timezone %#", async (meta) => {
    request.mockResolvedValueOnce(yahooPayload({ ...vixMetadata, ...meta }, vixTimestamps));
    await expect(complete(new EodPriceProvider(env).yahoo("VIX", "2026-09-09", "2026-09-10", [])))
      .rejects.toThrow("yahoo-instrument-identity-unverified");
  });

  it.each([
    { ticker: "INSR", meta: { symbol: "^INSR", instrumentType: "INDEX", shortName: "NASDAQ Insurance" } },
    { ticker: "AAA", meta: { symbol: "AAA", instrumentType: "EQUITY", shortName: "Example equity" } },
  ])("keeps the New York identity requirement for non-VIX $ticker", async ({ ticker, meta }) => {
    request.mockResolvedValueOnce(yahooPayload({ ...meta, exchangeTimezoneName: "America/Chicago" }));
    await expect(complete(new EodPriceProvider(env).yahoo(ticker, "2026-09-04", "2026-09-08", sipOverlap())))
      .rejects.toThrow("yahoo-instrument-identity-unverified");
  });

  it("accepts the exact configured Nasdaq Insurance index only with verified metadata", async () => {
    request.mockResolvedValueOnce(yahooPayload({ symbol: "^INSR", instrumentType: "INDEX", shortName: "NASDAQ Insurance" }));
    const bars = await complete(new EodPriceProvider(env).yahoo("INSR", "2026-09-04", "2026-09-08", []));
    expect(bars).toHaveLength(2);
    expect(bars.every((bar) => bar.ticker === "INSR" && bar.reportedVolume === null)).toBe(true);
  });

  it.each([
    { symbol: "INSR.OL", instrumentType: "EQUITY", shortName: "Insr Insurance Group" },
    { symbol: "^INSR", instrumentType: "INDEX", shortName: "Different index" },
    { symbol: "^INSR", instrumentType: "INDEX", shortName: "NASDAQ Insurance", exchangeTimezoneName: "Europe/Oslo" },
  ])("rejects an unverified index identity %#", async (meta) => {
    request.mockResolvedValueOnce(yahooPayload(meta));
    await expect(complete(new EodPriceProvider(env).yahoo("INSR", "2026-09-04", "2026-09-08", []))).rejects.toThrow("yahoo-instrument-identity-unverified");
  });

  it("requires same-symbol, same-basis SIP overlap and excludes future sessions", async () => {
    const overlap = ["2026-09-04", "2026-09-08"].map((date): EodPriceBar => ({
      ticker: "AAA", date, o: 100, h: 101, l: 99, c: 100, volume: 1000, reportedVolume: 1000,
      feed: "sip", sourceProvider: "alpaca", adjustment: "split", fetchedAt: null, observedAt: null,
    }));
    request.mockResolvedValueOnce(yahooPayload({}, ["2026-09-04T13:30:00Z", "2026-09-08T13:30:00Z", "2026-09-09T13:30:00Z"]));
    expect(await complete(new EodPriceProvider(env).yahoo("AAA", "2026-09-04", "2026-09-08", overlap))).toHaveLength(2);
    request.mockResolvedValueOnce(yahooPayload({}));
    await expect(complete(new EodPriceProvider(env).yahoo("AAA", "2026-09-04", "2026-09-08",
      overlap.map((bar) => ({ ...bar, ticker: "BBB" }))))).rejects.toThrow("yahoo-price-basis-unverified");
    request.mockResolvedValueOnce(yahooPayload({}));
    await expect(complete(new EodPriceProvider(env).yahoo("AAA", "2026-09-04", "2026-09-08",
      overlap.map((bar) => ({ ...bar, c: 200 }))))).rejects.toThrow("yahoo-price-basis-unverified");
  });

  it("invalidates an archived Yahoo window when current Alpaca split prices change its basis", () => {
    const current=sipOverlap();
    const archived=current.map((bar):EodPriceBar => ({...bar,sourceProvider:"yahoo",feed:"yahoo-eod",reportedVolume:null}));
    expect(yahooWindowMatchesAlpaca("AAA",archived,current)).toBe(true);
    const corrected=current.map((bar) => ({...bar,o:50,h:50.5,l:49.5,c:50}));
    expect(yahooWindowMatchesAlpaca("AAA",archived,corrected)).toBe(false);
    const refreshed=archived.map((bar) => ({...bar,o:50,h:50.5,l:49.5,c:50}));
    expect(yahooWindowMatchesAlpaca("AAA",refreshed,corrected)).toBe(true);
    expect(yahooWindowMatchesAlpaca("AAA",archived,current.slice(0,1))).toBe(false);
    expect(yahooWindowMatchesAlpaca("AAA",archived,current.map((bar) => ({...bar,adjustment:"raw"})))).toBe(false);
    expect(yahooWindowMatchesAlpaca("AAA",archived,current.map((bar) => ({...bar,feed:"iex"})))).toBe(false);
    expect(yahooWindowMatchesAlpaca("AAA",archived,current.map((bar) => ({...bar,ticker:"BBB"})))).toBe(false);
  });

  it("never uses dividend-adjusted adjclose to compute prices or to satisfy split-basis verification", async () => {
    type Fixture={chart:{result:[{indicators:{adjclose?:Array<{adjclose:number[]}>;
      quote:Array<{open:number[];high:number[];low:number[];close:number[];volume:number[]}>}}]}};
    const body=await yahooPayload({}).json() as Fixture;
    body.chart.result[0].indicators.adjclose=[{adjclose:[50,50]}];
    request.mockResolvedValueOnce(Response.json(body));
    const bars=await complete(new EodPriceProvider(env).yahoo("AAA","2026-09-04","2026-09-08",sipOverlap()));
    expect(bars.map((bar) => bar.c)).toEqual([100,100]);
    body.chart.result[0].indicators.quote[0]={open:[200,200],high:[201,201],low:[199,199],close:[200,200],volume:[999,999]};
    body.chart.result[0].indicators.adjclose=[{adjclose:[100,100]}];
    request.mockResolvedValueOnce(Response.json(body));
    await expect(complete(new EodPriceProvider(env).yahoo("AAA","2026-09-04","2026-09-08",sipOverlap())))
      .rejects.toThrow("yahoo-price-basis-unverified");
  });
});
