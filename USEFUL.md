## Checking ETF Constituent List (Run in powershell in project directory)
# Last sync status per ETF (timestamp, status, source, errors, row count)
npx wrangler d1 execute market_command --remote --command "SELECT etf_ticker, last_synced_at, status, source, records_count, error, updated_at FROM etf_constituent_sync_status ORDER BY updated_at DESC LIMIT 100"

# Constituents currently stored for a specific ETF (example: VPU)
npx wrangler d1 execute market_command --remote --command "SELECT etf_ticker, constituent_ticker, constituent_name, weight, as_of_date, source, updated_at FROM etf_constituents WHERE etf_ticker='VPU' ORDER BY weight DESC, constituent_ticker ASC"

# Compare latest two stored bars for a ticker (example: NEE)
npx wrangler d1 execute market_command --remote --command "SELECT ticker, date, c FROM daily_bars WHERE ticker='NEE' ORDER BY date DESC LIMIT 2"
