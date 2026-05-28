import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshDailyBarsIncremental } from "../src/daily-bars";
import { getProvider, type DailyBar, type MarketDataProvider } from "../src/provider";

function createDailyBarsEnv(seed: Record<string, DailyBar[]> = {}) {
  const barsByTicker = new Map(
    Object.entries(seed).map(([ticker, bars]) => [ticker.toUpperCase(), [...bars]]),
  );
  const symbols = new Set<string>();

  const runStatement = (sql: string, args: unknown[]) => {
    if (sql.includes("INSERT OR IGNORE INTO symbols")) {
      const ticker = args[0];
      if (ticker != null) symbols.add(String(ticker).toUpperCase());
    }
    if (sql.includes("INSERT OR REPLACE INTO daily_bars")) {
      const [ticker, date, o, h, l, c, volume] = args;
      const normalizedTicker = String(ticker).toUpperCase();
      const rows = barsByTicker.get(normalizedTicker) ?? [];
      const next = {
        ticker: normalizedTicker,
        date: String(date),
        o: Number(o ?? 0),
        h: Number(h ?? 0),
        l: Number(l ?? 0),
        c: Number(c ?? 0),
        volume: Number(volume ?? 0),
      };
      const filtered = rows.filter((row) => row.date !== next.date);
      filtered.push(next);
      filtered.sort((left, right) => left.date.localeCompare(right.date));
      barsByTicker.set(normalizedTicker, filtered);
      symbols.add(normalizedTicker);
    }
  };

  const env = {
    DB: {
      prepare(sql: string) {
        const makeBound = (args: unknown[]) => ({
          __sql: sql,
          __args: args,
          async all<T>() {
            if (sql.includes("SELECT ticker, MAX(date) as lastDate")) {
              return {
                results: args.flatMap((arg) => {
                  const ticker = String(arg).toUpperCase();
                  const rows = barsByTicker.get(ticker) ?? [];
                  const latest = rows.map((row) => row.date).sort().at(-1);
                  return latest ? [{ ticker, lastDate: latest }] : [];
                }) as T[],
              };
            }
            return { results: [] as T[] };
          },
          async run() {
            runStatement(sql, args);
            return {};
          },
        });
        return {
          bind(...args: unknown[]) {
            return makeBound(args);
          },
          async all<T>() {
            return makeBound([]).all<T>();
          },
          async run() {
            return makeBound([]).run();
          },
        };
      },
      async batch(statements: Array<{ __sql?: string; __args?: unknown[] }>) {
        for (const statement of statements) {
          if (statement.__sql) runStatement(statement.__sql, statement.__args ?? []);
        }
        return [];
      },
    },
  } as any;

  return { env, barsByTicker, symbols };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("refreshDailyBarsIncremental", () => {
  it("checkpoints successful provider chunks and continues after a failed chunk", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env, barsByTicker } = createDailyBarsEnv();
    const provider: MarketDataProvider = {
      label: "test provider",
      getDailyBars: vi.fn(async (tickers: string[], _startDate: string, endDate: string) => {
        if (tickers.includes("BAD")) throw new Error("provider timeout");
        return tickers.map((ticker) => ({
          ticker,
          date: endDate,
          o: 10,
          h: 11,
          l: 9,
          c: 10,
          volume: 1_000,
        }));
      }),
    };

    const result = await refreshDailyBarsIncremental(env, {
      tickers: ["AAA", "BAD", "BBB"],
      startDate: "2026-05-27",
      endDate: "2026-05-27",
      provider,
      providerBatchSize: 1,
      continueOnError: true,
    });

    expect(result).toMatchObject({
      requestedTickers: 3,
      fetchedRows: 2,
      writtenRows: 2,
      skippedCurrentTickers: 0,
    });
    expect(barsByTicker.get("AAA")?.at(-1)?.date).toBe("2026-05-27");
    expect(barsByTicker.get("BBB")?.at(-1)?.date).toBe("2026-05-27");
    expect(barsByTicker.has("BAD")).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith("daily bars provider chunk failed", expect.objectContaining({
      tickers: ["BAD"],
    }));
  });
});

describe("provider fetch timeouts", () => {
  it("returns no bars instead of hanging when fallback fetches time out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      })
    )));

    const provider = getProvider({ DB: {} as D1Database, DATA_PROVIDER: "stooq" });
    const promise = provider.getDailyBars(["AAA"], "2026-05-26", "2026-05-27");

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(promise).resolves.toEqual([]);
  });
});
