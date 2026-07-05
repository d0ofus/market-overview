ALTER TABLE option_contract_quotes ADD COLUMN row_kind TEXT NOT NULL DEFAULT 'candidate';

CREATE INDEX IF NOT EXISTS idx_option_contract_quotes_row_kind_ticker
  ON option_contract_quotes (row_kind, ticker);
