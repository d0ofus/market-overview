import { NextResponse } from "next/server";
import { TRADINGVIEW_STOCK_FIELDS } from "@/lib/tradingview-stock-fields";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = normalizeQuery(searchParams.get("q") ?? "");
  const requestedLimit = Number(searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_LIMIT));

  const rows = TRADINGVIEW_STOCK_FIELDS
    .filter((field) => {
      if (!q) return true;
      return field.value.toLowerCase().includes(q) || field.label.toLowerCase().includes(q);
    })
    .slice(0, limit);

  return NextResponse.json({
    rows,
    total: rows.length,
    query: q,
  });
}
