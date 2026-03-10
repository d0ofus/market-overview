CREATE TABLE IF NOT EXISTS tv_alert_emails (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  source_mailbox TEXT,
  raw_email_subject TEXT,
  raw_email_from TEXT,
  raw_email_received_at TEXT,
  raw_headers_json TEXT,
  raw_text TEXT,
  raw_html TEXT,
  raw_payload_json TEXT,
  parse_status TEXT NOT NULL DEFAULT 'pending',
  parse_error TEXT,
  parsed_alert_id TEXT,
  parsed_ticker TEXT,
  parsed_trading_day TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(message_id)
);

CREATE INDEX IF NOT EXISTS idx_tv_alert_emails_received_at
  ON tv_alert_emails(raw_email_received_at DESC);

CREATE TABLE IF NOT EXISTS tv_alerts (
  id TEXT PRIMARY KEY,
  email_id TEXT,
  ticker TEXT NOT NULL,
  alert_type TEXT,
  strategy_name TEXT,
  raw_payload TEXT,
  raw_email_subject TEXT,
  raw_email_from TEXT,
  raw_email_received_at TEXT,
  received_at TEXT NOT NULL,
  market_session TEXT NOT NULL,
  trading_day TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'email',
  normalized_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(normalized_key),
  FOREIGN KEY (email_id) REFERENCES tv_alert_emails(id)
);

CREATE INDEX IF NOT EXISTS idx_tv_alerts_received_at_desc
  ON tv_alerts(received_at DESC);

CREATE INDEX IF NOT EXISTS idx_tv_alerts_ticker_trading_day
  ON tv_alerts(ticker, trading_day);

CREATE INDEX IF NOT EXISTS idx_tv_alerts_session_trading_day
  ON tv_alerts(market_session, trading_day);

CREATE INDEX IF NOT EXISTS idx_tv_alerts_trading_day
  ON tv_alerts(trading_day);

CREATE TABLE IF NOT EXISTS ticker_news (
  id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  trading_day TEXT NOT NULL,
  headline TEXT NOT NULL,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at TEXT,
  snippet TEXT,
  fetched_at TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(canonical_key)
);

CREATE INDEX IF NOT EXISTS idx_ticker_news_ticker_trading_day
  ON ticker_news(ticker, trading_day);

CREATE INDEX IF NOT EXISTS idx_ticker_news_fetched_at_desc
  ON ticker_news(fetched_at DESC);

CREATE TABLE IF NOT EXISTS ticker_news_fetch_cache (
  ticker TEXT NOT NULL,
  trading_day TEXT NOT NULL,
  last_attempt_at TEXT,
  last_success_at TEXT,
  status TEXT NOT NULL DEFAULT 'empty',
  item_count INTEGER NOT NULL DEFAULT 0,
  provider_trace_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticker, trading_day)
);

CREATE INDEX IF NOT EXISTS idx_ticker_news_fetch_cache_attempt_desc
  ON ticker_news_fetch_cache(last_attempt_at DESC);

