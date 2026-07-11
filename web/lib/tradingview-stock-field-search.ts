import {
  TRADINGVIEW_STOCK_FIELDS,
  type TradingViewStockField,
} from "./tradingview-stock-fields";

export type TradingViewStockFieldSummary = {
  value: string;
  label: string;
  type: string;
  hasOptions: boolean;
  optionCount: number;
};

export type TradingViewStockFieldOption = {
  value: string;
  label?: string;
};

export function normalizeTradingViewStockFieldQuery(value: string): string {
  return value.trim().toLowerCase();
}

export function summarizeTradingViewStockField(field: TradingViewStockField): TradingViewStockFieldSummary {
  const optionCount = field.optionCount ?? field.options?.length ?? 0;
  return {
    value: field.value,
    label: field.label,
    type: field.type,
    hasOptions: optionCount > 0,
    optionCount,
  };
}

export function searchTradingViewStockFields(query: string, limit: number): {
  rows: TradingViewStockFieldSummary[];
  total: number;
  query: string;
} {
  const q = normalizeTradingViewStockFieldQuery(query);
  const matches = TRADINGVIEW_STOCK_FIELDS.filter((field) => {
    if (!q) return true;
    return field.value.toLowerCase().includes(q) || field.label.toLowerCase().includes(q);
  });
  return {
    rows: matches.slice(0, limit).map(summarizeTradingViewStockField),
    total: matches.length,
    query: q,
  };
}

export function searchTradingViewStockFieldOptions(field: string, optionQuery: string, limit: number): {
  field: TradingViewStockFieldSummary | null;
  rows: TradingViewStockFieldOption[];
  total: number;
  query: string;
} {
  const optionQ = normalizeTradingViewStockFieldQuery(optionQuery);
  const selected = TRADINGVIEW_STOCK_FIELDS.find((row) => row.value === field.trim());
  const matches = (selected?.options ?? []).filter((option) => {
    if (!optionQ) return true;
    return option.value.toLowerCase().includes(optionQ) || (option.label ?? "").toLowerCase().includes(optionQ);
  });
  return {
    field: selected ? summarizeTradingViewStockField(selected) : null,
    rows: matches.slice(0, limit),
    total: matches.length,
    query: optionQ,
  };
}
