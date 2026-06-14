CREATE TABLE IF NOT EXISTS watchlist_factor_settings (
  id TEXT PRIMARY KEY,
  factor_config_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO watchlist_factor_settings (
  id,
  factor_config_json,
  created_at,
  updated_at
) VALUES (
  'default',
  '{"enabled":{"priceAboveSma200":true,"priceAbove":true,"marketCapAbove":true,"within52WeekHigh":true,"priorStrongMove":true,"strongSector":true,"avg10dDollarVolume":true,"increasingVolumeProfile":true,"positiveRevenueGrowth":true,"positiveEpsGrowth":true,"acceleratingRevenueGrowth":true,"acceleratingEpsGrowth":true,"averageTradingRangePct":true},"thresholds":{"priceAbove":{"minPrice":10},"marketCapAbove":{"minMarketCapMillions":500},"within52WeekHigh":{"maxDistancePct":15},"priorStrongMove":{"movePct":50,"lookbackMonths":3},"strongSector":{"lookbackMonths":3},"avg10dDollarVolume":{"minDollarVolumeMillions":20},"increasingVolumeProfile":{"lookbackMonths":3,"minTrendPct":0},"acceleratingRevenueGrowth":{"minAccelerationPct":0},"acceleratingEpsGrowth":{"minAccelerationPct":0},"averageTradingRangePct":{"minAtrPct":3}}}',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
