import type { Env } from "./types";

export type DailyBar = {
  ticker: string;
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
};

export interface MarketDataProvider {
  label: string;
  getDailyBars(tickers: string[], startDate: string, endDate: string): Promise<DailyBar[]>;
  getQuoteSnapshot?(tickers: string[]): Promise<Record<string, { price: number; prevClose: number }>>;
}

class SyntheticProvider implements MarketDataProvider {
  label = "Synthetic Seeded EOD";
  async getDailyBars(): Promise<DailyBar[]> {
    return [];
  }
}

export function getProvider(env: Env): MarketDataProvider {
  const mode = (env.DATA_PROVIDER ?? "synthetic").toLowerCase();
  if (mode === "synthetic" || mode === "csv") return new SyntheticProvider();
  return new SyntheticProvider();
}
