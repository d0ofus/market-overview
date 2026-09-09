-- Market database only. Existing publications remain available during shadow rollout.
CREATE TABLE IF NOT EXISTS market_calendar_refresh_state (
  id TEXT PRIMARY KEY,
  covered_start TEXT NOT NULL,
  covered_end TEXT NOT NULL,
  verified_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS eod_publications (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  session_date TEXT NOT NULL,
  revision INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  methodology_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_checksum TEXT,
  payload_codec TEXT NOT NULL DEFAULT 'json',
  payload_base64 TEXT,
  status TEXT NOT NULL CHECK(status IN ('candidate','accepted','rejected')),
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  UNIQUE(scope, session_date, input_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_eod_publications_history
  ON eod_publications(scope, status, session_date DESC, revision DESC);
CREATE TABLE IF NOT EXISTS eod_publication_pointers (
  scope TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES eod_publications(id),
  session_date TEXT NOT NULL,
  published_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS eod_input_revisions (
  feed TEXT NOT NULL,
  ticker TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  -- Constant-size semantic evidence, not a per-bar change journal. Unknown
  -- writers leave semantic_revision behind and cannot authorize old catalogs.
  semantic_revision INTEGER NOT NULL DEFAULT 0,
  last_correction_revision INTEGER NOT NULL DEFAULT 0,
  append_high_water_date TEXT,
  append_epoch_start_revision INTEGER,
  append_epoch_start_date TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(feed,ticker)
) STRICT, WITHOUT ROWID;
-- One indexed watermark lets the coordinator detect corrections after a
-- completed publication without polling the entire security revision manifest.
CREATE TABLE IF NOT EXISTS eod_input_clock (
  id TEXT PRIMARY KEY CHECK(id='default'),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0)
) STRICT, WITHOUT ROWID;
INSERT INTO eod_input_clock(id,revision) VALUES('default',0) ON CONFLICT(id) DO NOTHING;
CREATE TRIGGER IF NOT EXISTS eod_revision_clock_insert AFTER INSERT ON eod_input_revisions
WHEN NEW.feed IN ('sip','yahoo-eod') BEGIN
  UPDATE eod_input_clock SET revision=revision+1 WHERE id='default';
END;
CREATE TRIGGER IF NOT EXISTS eod_revision_clock_update AFTER UPDATE ON eod_input_revisions
WHEN (OLD.feed IN ('sip','yahoo-eod') OR NEW.feed IN ('sip','yahoo-eod'))
  AND (OLD.revision IS NOT NEW.revision OR OLD.feed IS NOT NEW.feed OR OLD.ticker IS NOT NEW.ticker) BEGIN
  UPDATE eod_input_clock SET revision=revision+1 WHERE id='default';
END;
CREATE TRIGGER IF NOT EXISTS eod_revision_clock_delete AFTER DELETE ON eod_input_revisions
WHEN OLD.feed IN ('sip','yahoo-eod') BEGIN
  UPDATE eod_input_clock SET revision=revision+1 WHERE id='default';
END;
ALTER TABLE alpaca_daily_bars ADD COLUMN reported_volume REAL;
ALTER TABLE alpaca_daily_bars ADD COLUMN reported_volume_collected_at TEXT;
ALTER TABLE daily_market_features ADD COLUMN input_revision INTEGER;
CREATE TABLE IF NOT EXISTS eod_adjustment_repairs (
  feed TEXT NOT NULL,
  ticker TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','complete')),
  owner_token TEXT,
  start_date TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(feed,ticker)
) STRICT, WITHOUT ROWID;
-- Transient exact-row markers exist only inside the atomic verified-relocation
-- register/delete/cleanup batch. They never authorize ordinary/manual deletes.
CREATE TABLE IF NOT EXISTS eod_history_relocations (
  feed TEXT NOT NULL,
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  bar_identity TEXT NOT NULL,
  PRIMARY KEY(feed,ticker,date)
) STRICT, WITHOUT ROWID;
-- Every writer, including legacy/manual paths, invalidates input manifests.
-- Keep whitespace around CASE/END tokens for Wrangler's migration SQL splitter.
CREATE TRIGGER IF NOT EXISTS eod_bar_insert AFTER INSERT ON alpaca_daily_bars BEGIN
  INSERT INTO eod_input_revisions(feed,ticker,semantic_revision,last_correction_revision,
    append_high_water_date,append_epoch_start_revision,append_epoch_start_date)
  SELECT NEW.feed,NEW.ticker,1,
    CASE WHEN high_water>NEW.date THEN 1 ELSE 0 END ,high_water,
    CASE WHEN high_water>NEW.date THEN NULL ELSE 1 END ,
    CASE WHEN high_water>NEW.date THEN NULL ELSE NEW.date END
  FROM (SELECT date AS high_water FROM alpaca_daily_bars
    WHERE feed=NEW.feed AND ticker=NEW.ticker ORDER BY date DESC LIMIT 1) WHERE 1
  ON CONFLICT(feed,ticker) DO UPDATE SET
    revision=revision+1,semantic_revision=revision+1,updated_at=CURRENT_TIMESTAMP,
    last_correction_revision= CASE WHEN semantic_revision<>revision OR append_high_water_date IS NULL
      OR NEW.date<=append_high_water_date THEN revision+1 ELSE last_correction_revision END ,
    append_epoch_start_revision= CASE WHEN semantic_revision<>revision OR append_high_water_date IS NULL
      OR NEW.date<=append_high_water_date THEN NULL ELSE COALESCE(append_epoch_start_revision,revision+1) END ,
    append_epoch_start_date= CASE WHEN semantic_revision<>revision OR append_high_water_date IS NULL
      OR NEW.date<=append_high_water_date THEN NULL ELSE COALESCE(append_epoch_start_date,NEW.date) END ,
    append_high_water_date=MAX(COALESCE(append_high_water_date,excluded.append_high_water_date),excluded.append_high_water_date);
END;
CREATE TRIGGER IF NOT EXISTS eod_bar_update AFTER UPDATE ON alpaca_daily_bars
WHEN OLD.feed IS NOT NEW.feed OR OLD.ticker IS NOT NEW.ticker OR OLD.date IS NOT NEW.date
  OR OLD.o IS NOT NEW.o OR OLD.h IS NOT NEW.h OR OLD.l IS NOT NEW.l
  OR OLD.c IS NOT NEW.c OR OLD.volume IS NOT NEW.volume
  OR OLD.reported_volume IS NOT NEW.reported_volume
  OR OLD.adjustment IS NOT NEW.adjustment OR OLD.source_provider IS NOT NEW.source_provider
BEGIN
  INSERT INTO eod_input_revisions(feed,ticker,semantic_revision,last_correction_revision,append_high_water_date)
  VALUES(NEW.feed,NEW.ticker,1,1,
    (SELECT date FROM alpaca_daily_bars WHERE feed=NEW.feed AND ticker=NEW.ticker ORDER BY date DESC LIMIT 1))
  ON CONFLICT(feed,ticker) DO UPDATE SET revision=revision+1,semantic_revision=revision+1,
    last_correction_revision=revision+1,append_epoch_start_revision=NULL,append_epoch_start_date=NULL,
    append_high_water_date=MAX(COALESCE(append_high_water_date,excluded.append_high_water_date),excluded.append_high_water_date),updated_at=CURRENT_TIMESTAMP;
  -- Moving a bar also invalidates the security that lost it. A date-only move
  -- belongs to the same security and is already covered by the increment above.
  INSERT INTO eod_input_revisions(feed,ticker,semantic_revision,last_correction_revision,append_high_water_date)
  SELECT OLD.feed,OLD.ticker,1,1,MAX(OLD.date,COALESCE(
    (SELECT date FROM alpaca_daily_bars WHERE feed=OLD.feed AND ticker=OLD.ticker ORDER BY date DESC LIMIT 1),OLD.date))
  WHERE OLD.feed IS NOT NEW.feed OR OLD.ticker IS NOT NEW.ticker
  ON CONFLICT(feed,ticker) DO UPDATE SET revision=revision+1,semantic_revision=revision+1,
    last_correction_revision=revision+1,append_epoch_start_revision=NULL,append_epoch_start_date=NULL,
    append_high_water_date=MAX(COALESCE(append_high_water_date,excluded.append_high_water_date),excluded.append_high_water_date),updated_at=CURRENT_TIMESTAMP;
END;
CREATE TRIGGER IF NOT EXISTS eod_bar_delete AFTER DELETE ON alpaca_daily_bars
WHEN NOT EXISTS (SELECT 1 FROM eod_history_relocations relocation
  WHERE relocation.feed=OLD.feed AND relocation.ticker=OLD.ticker AND relocation.date=OLD.date
    AND relocation.bar_identity IS json_array(OLD.o,OLD.h,OLD.l,OLD.c,OLD.volume,OLD.reported_volume,
      OLD.reported_volume_collected_at,OLD.source_provider,OLD.adjustment,OLD.observed_at,OLD.fetched_at)) BEGIN
  INSERT INTO eod_input_revisions(feed,ticker,semantic_revision,last_correction_revision,append_high_water_date)
  VALUES(OLD.feed,OLD.ticker,1,1,MAX(OLD.date,COALESCE(
    (SELECT date FROM alpaca_daily_bars WHERE feed=OLD.feed AND ticker=OLD.ticker ORDER BY date DESC LIMIT 1),OLD.date)))
  ON CONFLICT(feed,ticker) DO UPDATE SET revision=revision+1,semantic_revision=revision+1,
    last_correction_revision=revision+1,append_epoch_start_revision=NULL,append_epoch_start_date=NULL,
    append_high_water_date=MAX(COALESCE(append_high_water_date,excluded.append_high_water_date),excluded.append_high_water_date),updated_at=CURRENT_TIMESTAMP;
END;
