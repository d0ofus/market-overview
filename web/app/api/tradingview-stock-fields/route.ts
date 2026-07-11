import { NextResponse } from "next/server";
import {
  normalizeTradingViewStockFieldQuery,
  searchTradingViewStockFieldOptions,
  searchTradingViewStockFields,
} from "@/lib/tradingview-stock-field-search";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = normalizeTradingViewStockFieldQuery(searchParams.get("q") ?? "");
  const field = searchParams.get("field")?.trim() ?? "";
  const optionQ = normalizeTradingViewStockFieldQuery(searchParams.get("optionQ") ?? "");
  const requestedLimit = Number(searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_LIMIT));

  if (field) {
    return NextResponse.json(searchTradingViewStockFieldOptions(field, optionQ, limit));
  }

  return NextResponse.json(searchTradingViewStockFields(q, limit));
}
