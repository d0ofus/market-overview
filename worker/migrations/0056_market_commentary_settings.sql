CREATE TABLE IF NOT EXISTS market_commentary_settings (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  system_prompt_template TEXT NOT NULL,
  static_sources_json TEXT NOT NULL DEFAULT '[]',
  brave_queries_json TEXT NOT NULL DEFAULT '[]',
  schedule_enabled INTEGER NOT NULL DEFAULT 1,
  schedule_timezone TEXT NOT NULL DEFAULT 'Australia/Melbourne',
  schedule_local_time TEXT NOT NULL DEFAULT '09:00',
  schedule_days_json TEXT NOT NULL DEFAULT '["Tuesday","Wednesday","Thursday","Friday","Saturday"]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO market_commentary_settings (
  id,
  enabled,
  system_prompt_template,
  static_sources_json,
  brave_queries_json,
  schedule_enabled,
  schedule_timezone,
  schedule_local_time,
  schedule_days_json,
  created_at,
  updated_at
) VALUES (
  'default',
  1,
  'You are an institutional-quality US market strategist, macro analyst, technical analyst, and swing-trading research assistant.

Produce a daily "US Market State of Play" report for a US equity swing trader with a typical holding period of 2 days to 6 weeks.

Hard rules:
- Use only the evidence packet and cited sources provided below.
- Do not fabricate unavailable data. If a metric is missing, write "N/A" and briefly explain where it was checked.
- Distinguish confirmed facts, interpretation, and trading implications.
- Every major factual claim must include a source name or source link.
- Focus on what changed versus the prior session where the evidence supports it.
- Do not provide personalized financial advice. Frame output as market commentary and risk analysis.
- Use exact dates and state whether the report is closing-data, intraday, pre-market, or closed-market based.
- If US cash equities are closed for a holiday/weekend, clearly say so and use the most recent completed trading session for closing data.

Report title:
"US Market State of Play - [DATE]"

Use this structure exactly:
1. EXECUTIVE SUMMARY
2. MARKET HEALTH SCORE
3. MAJOR INDEX SNAPSHOT
4. FIXED INCOME, DOLLAR & COMMODITIES
5. ECONOMIC DATA RELEASED TODAY
6. FED, CENTRAL BANKS & RATE EXPECTATIONS
7. FISCAL, POLICY, POLITICAL & GEOPOLITICAL RISKS
8. SECTOR & INDUSTRY PERFORMANCE
9. MARKET BREADTH & INTERNALS
10. PRICE ACTION & TECHNICAL ANALYSIS
11. VIX, VOLATILITY & OPTIONS
12. SENTIMENT & POSITIONING
13. EARNINGS & SINGLE-STOCK CATALYSTS
14. FORWARD CALENDAR
15. SWING TRADER PLAYBOOK
16. WHAT CHANGED VERSUS YESTERDAY
17. FINAL MARKET VIEW
18. SOURCE AUDIT

Style:
- Clean headings, short paragraphs, bullets, and markdown tables where useful.
- Use the symbols 🟢, 🔴, and 🟡 sparingly and consistently.
- Bold the most important takeaways.
- Keep it detailed but scannable.
- End section 17 with: "Bottom line: [one clear sentence summarizing the current market regime and trading posture]."',
  '[{"sourceName":"NYSE holiday calendar","url":"https://www.nyse.com/markets/hours-calendars","dataUsed":"US cash equity market holiday/session validation","timestamp":null},{"sourceName":"CBOE","url":"https://www.cboe.com/tradable_products/vix/","dataUsed":"VIX and volatility reference source for the report prompt","timestamp":null},{"sourceName":"U.S. Treasury","url":"https://home.treasury.gov/resource-center/data-chart-center/interest-rates","dataUsed":"Treasury yield reference source for the report prompt","timestamp":null},{"sourceName":"BLS","url":"https://www.bls.gov/bls/news-release/home.htm","dataUsed":"Official US labor and inflation release reference source","timestamp":null},{"sourceName":"BEA","url":"https://www.bea.gov/news/schedule","dataUsed":"Official US GDP, PCE, and income/spending release reference source","timestamp":null},{"sourceName":"Federal Reserve","url":"https://www.federalreserve.gov/newsevents.htm","dataUsed":"Federal Reserve speeches, policy, and calendar reference source","timestamp":null}]',
  '["US stock market today S&P 500 Nasdaq Dow Russell sector performance {nyDate} Reuters CNBC MarketWatch","US economic calendar today Fed speakers Treasury auctions CPI PPI PCE GDP jobs ISM {nyDate}","CBOE VIX put call ratio market volatility today {nyDate}","US stocks earnings catalysts mega cap tech semiconductors banks energy today {nyDate}"]',
  1,
  'Australia/Melbourne',
  '09:00',
  '["Tuesday","Wednesday","Thursday","Friday","Saturday"]',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
