CREATE TABLE IF NOT EXISTS watchlist_review_runs (
  id TEXT PRIMARY KEY,
  source_watchlist_name TEXT,
  source_watchlist_id TEXT,
  watchlist_set_id TEXT,
  watchlist_run_id TEXT,
  total_tickers_scanned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('draft', 'ready', 'partially_approved', 'applied', 'archived')),
  notes TEXT,
  summary_counts_json TEXT NOT NULL DEFAULT '{}',
  generated_by TEXT NOT NULL DEFAULT 'hermes' CHECK (generated_by IN ('hermes', 'manual', 'import')),
  analysis_version TEXT,
  export_path TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_watchlist_review_runs_created
  ON watchlist_review_runs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_watchlist_review_runs_watchlist
  ON watchlist_review_runs(watchlist_set_id, watchlist_run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS watchlist_review_candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  company_name TEXT,
  current_flag TEXT NOT NULL DEFAULT 'unknown' CHECK (current_flag IN ('red', 'blue', 'yellow', 'orange', 'unflagged', 'unknown')),
  proposed_flag TEXT NOT NULL DEFAULT 'manual_review' CHECK (proposed_flag IN ('red', 'blue', 'yellow', 'orange', 'keep', 'unflag', 'remove', 'manual_review')),
  recommendation_type TEXT NOT NULL CHECK (recommendation_type IN ('RED_TO_BLUE', 'RED_TO_YELLOW', 'BLUE_TO_RED', 'BLUE_TO_YELLOW', 'YELLOW_TO_BLUE', 'YELLOW_TO_RED', 'ANY_TO_UNFLAG', 'KEEP_CURRENT', 'MANUAL_REVIEW')),
  confidence REAL NOT NULL DEFAULT 0,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  sector_context_json TEXT,
  chart_image_url TEXT,
  chart_snapshot_path TEXT,
  data_freshness_json TEXT NOT NULL DEFAULT '{}',
  analysis_source TEXT NOT NULL DEFAULT 'data_only' CHECK (analysis_source IN ('data_only', 'mini_chart', 'full_chart_vision', 'manual')),
  destructive_action INTEGER NOT NULL DEFAULT 0,
  destructive_confirmed INTEGER NOT NULL DEFAULT 0,
  removal_reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'skipped', 'overridden', 'applied')),
  user_override_flag TEXT CHECK (user_override_flag IN ('red', 'blue', 'yellow', 'orange', 'keep', 'unflag', 'remove', 'manual_review')),
  user_note TEXT,
  approved_by TEXT,
  approved_at TEXT,
  applied_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, ticker),
  FOREIGN KEY (run_id) REFERENCES watchlist_review_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_review_candidates_run_status
  ON watchlist_review_candidates(run_id, status, confidence DESC, ticker);

CREATE INDEX IF NOT EXISTS idx_watchlist_review_candidates_run_move
  ON watchlist_review_candidates(run_id, recommendation_type, current_flag, proposed_flag);

CREATE INDEX IF NOT EXISTS idx_watchlist_review_candidates_destructive
  ON watchlist_review_candidates(run_id, destructive_action, destructive_confirmed);

CREATE TABLE IF NOT EXISTS watchlist_review_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  candidate_id TEXT,
  ticker TEXT,
  event_type TEXT NOT NULL,
  previous_status TEXT,
  next_status TEXT,
  previous_flag TEXT,
  next_flag TEXT,
  actor TEXT NOT NULL DEFAULT 'authorized-user',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES watchlist_review_runs(id),
  FOREIGN KEY (candidate_id) REFERENCES watchlist_review_candidates(id)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_review_events_run_candidate
  ON watchlist_review_events(run_id, candidate_id, created_at DESC);

INSERT OR IGNORE INTO watchlist_review_runs (
  id,
  source_watchlist_name,
  source_watchlist_id,
  total_tickers_scanned,
  status,
  notes,
  summary_counts_json,
  generated_by,
  analysis_version,
  created_at,
  updated_at
) VALUES (
  'watchlist-review-2026-06-12',
  'WatchlistComp-Daily Scans_06_11',
  NULL,
  222,
  'ready',
  'Sample Hermes review run for AI-assisted TradingView watchlist approvals.',
  '{"red_to_blue":0,"red_to_yellow":0,"blue_to_red":4,"blue_to_yellow":0,"yellow_to_blue":1,"yellow_to_red":0,"unflag":2,"keep_current":10,"manual_review":1}',
  'hermes',
  'v0.1',
  '2026-06-12T00:00:00.000Z',
  '2026-06-12T00:00:00.000Z'
);

INSERT OR IGNORE INTO watchlist_review_candidates (
  id, run_id, ticker, company_name, current_flag, proposed_flag, recommendation_type, confidence,
  reasons_json, metrics_json, sector_context_json, chart_image_url, chart_snapshot_path, data_freshness_json,
  analysis_source, destructive_action, removal_reason, status, created_at, updated_at
) VALUES
('sample-DAL','watchlist-review-2026-06-12','DAL','Delta Air Lines, Inc.','blue','red','BLUE_TO_RED',0.84,
 '["Near CP zone with constructive pressure","Strong close reclaimed short moving averages","Relative strength improved versus SPY"]',
 '{"return_1d":2.4,"return_3d":5.1,"return_5d":6.8,"return_20d":13.2,"distance_to_10dma":1.1,"distance_to_20dma":2.6,"distance_to_50dma":6.9,"volume_ratio_20d":1.45,"rs20_vs_spy":4.2,"rs63_vs_spy":11.8,"cp_notes":"Testing near-term pivot shelf after reclaim","adr_extension":"Acceptable extension from support","data_source":"tradingview"}',
 '{"sector":"Industrials","focus_now":true,"tags":["Airlines","Transport"]}',NULL,NULL,'{"latest_bar_date":"2026-06-11","expected_latest_session":"2026-06-11","is_stale":false,"source":"tradingview"}',
 'full_chart_vision',0,NULL,'pending','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z'),
('sample-CAT','watchlist-review-2026-06-12','CAT','Caterpillar Inc.','blue','red','BLUE_TO_RED',0.82,
 '["Strong stock near ATH multi-peak pivot zone","Multiple peaks and touches in pivot zone","Constructive action near breakout area"]',
 '{"return_1d":1.2,"return_3d":2.8,"return_5d":4.4,"return_20d":10.9,"distance_to_10dma":0.9,"distance_to_20dma":0.5,"distance_to_50dma":7.2,"volume_ratio_20d":1.18,"rs20_vs_spy":0.1,"rs63_vs_spy":17.3,"cp_notes":"ATH pivot zone carries extra weight","adr_extension":"Controlled","data_source":"tradingview"}',
 '{"sector":"Industrials","focus_now":false,"tags":["Machinery"]}',NULL,NULL,'{"latest_bar_date":"2026-06-11","expected_latest_session":"2026-06-11","is_stale":false,"source":"tradingview"}',
 'full_chart_vision',0,NULL,'pending','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z'),
('sample-VECO','watchlist-review-2026-06-12','VECO','Veeco Instruments Inc.','blue','red','BLUE_TO_RED',0.79,
 '["Fresh breakout from 64 pivot area","Range expansion acceptable for breakout context","Semiconductor equipment leadership remains constructive"]',
 '{"return_1d":3.6,"return_3d":7.9,"return_5d":12.4,"return_20d":18.2,"distance_to_10dma":5.1,"distance_to_20dma":8.7,"distance_to_50dma":18.8,"volume_ratio_20d":1.82,"rs20_vs_spy":9.5,"rs63_vs_spy":24.1,"cp_notes":"Fresh breakout can stay Red despite expansion","adr_extension":"Elevated but acceptable","data_source":"tradingview"}',
 '{"sector":"Technology","focus_now":true,"tags":["Semiconductors","Equipment"]}',NULL,NULL,'{"latest_bar_date":"2026-06-11","expected_latest_session":"2026-06-11","is_stale":false,"source":"tradingview"}',
 'full_chart_vision',0,NULL,'pending','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z'),
('sample-SNDK','watchlist-review-2026-06-12','SNDK','SanDisk Corporation','blue','red','BLUE_TO_RED',0.71,
 '["Loose but strong semiconductor memory leader","Fresh leadership and strong sector can override imperfect action","Needs quick chart confirmation before promotion"]',
 '{"return_1d":4.2,"return_3d":9.6,"return_5d":14.9,"return_20d":29.5,"distance_to_10dma":6.2,"distance_to_20dma":12.8,"distance_to_50dma":31.4,"volume_ratio_20d":1.64,"rs20_vs_spy":16.7,"rs63_vs_spy":43.2,"cp_notes":"Leadership override candidate; action loose","adr_extension":"Extended","data_source":"tradingview"}',
 '{"sector":"Technology","focus_now":true,"tags":["Semiconductors","Memory"]}',NULL,NULL,'{"latest_bar_date":"2026-06-11","expected_latest_session":"2026-06-11","is_stale":false,"source":"tradingview"}',
 'full_chart_vision',0,NULL,'pending','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z'),
('sample-BUD','watchlist-review-2026-06-12','BUD','Anheuser-Busch InBev SA/NV','blue','manual_review','MANUAL_REVIEW',0.54,
 '["Recent high rather than strong multi-touch pivot","Weak pivot quality reduces promotion appeal","About 6 percent rally over four sessions versus roughly 1.33 percent ADR"]',
 '{"return_1d":0.8,"return_3d":4.6,"return_5d":6.1,"return_20d":8.8,"distance_to_10dma":4.9,"distance_to_20dma":6.4,"distance_to_50dma":8.0,"volume_ratio_20d":0.94,"rs20_vs_spy":1.2,"rs63_vs_spy":2.1,"cp_notes":"Caution; weak pivot quality","adr_extension":"Extended versus ADR","data_source":"tradingview"}',
 '{"sector":"Consumer Staples","focus_now":false,"tags":["Beverages"]}',NULL,NULL,'{"latest_bar_date":"2026-06-11","expected_latest_session":"2026-06-11","is_stale":false,"source":"tradingview"}',
 'full_chart_vision',0,NULL,'pending','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z'),
('sample-DLR','watchlist-review-2026-06-12','DLR','Digital Realty Trust, Inc.','blue','keep','KEEP_CURRENT',0.77,
 '["Keep Blue around prior breakout zone near 182.85","No decisive invalidation yet","Still worth daily monitoring"]',
 '{"return_1d":-0.4,"return_3d":-1.1,"return_5d":0.6,"return_20d":5.0,"distance_to_20dma":1.8,"distance_to_50dma":4.6,"volume_ratio_20d":0.88,"rs20_vs_spy":2.6,"rs63_vs_spy":6.2,"cp_notes":"Prior breakout support near 182.85","data_source":"tradingview"}',
 '{"sector":"Real Estate","focus_now":false,"tags":["Data Centers"]}',NULL,NULL,'{"latest_bar_date":"2026-06-11","expected_latest_session":"2026-06-11","is_stale":false,"source":"tradingview"}',
 'data_only',0,NULL,'pending','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z'),
('sample-TSAT','watchlist-review-2026-06-12','TSAT','Telesat Corporation','blue','keep','KEEP_CURRENT',0.76,
 '["Keep Blue after latest 13.95 percent higher-volume rally","Strong latest-session demand argues against demotion","Chart still deserves daily review"]',
 '{"return_1d":13.95,"return_3d":17.2,"return_5d":21.0,"return_20d":38.5,"distance_to_20dma":18.4,"distance_to_50dma":30.2,"volume_ratio_20d":2.65,"rs20_vs_spy":28.4,"rs63_vs_spy":51.0,"cp_notes":"Strong-volume rally after volatility","data_source":"tradingview"}',
 '{"sector":"Communication Services","focus_now":true,"tags":["Satellite"]}',NULL,NULL,'{"latest_bar_date":"2026-06-11","expected_latest_session":"2026-06-11","is_stale":false,"source":"tradingview"}',
 'mini_chart',0,NULL,'pending','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z'),
('sample-SATL','watchlist-review-2026-06-12','SATL','Satellogic Inc.','blue','keep','KEEP_CURRENT',0.74,
 '["Keep Blue after latest 19.75 percent rally","Momentum remains powerful enough for daily monitoring","Needs chart review for support quality"]',
 '{"return_1d":19.75,"return_3d":24.0,"return_5d":27.3,"return_20d":41.6,"distance_to_20dma":22.0,"distance_to_50dma":36.1,"volume_ratio_20d":2.2,"rs20_vs_spy":33.2,"rs63_vs_spy":58.7,"cp_notes":"High volatility, still monitor daily","data_source":"tradingview"}',
 '{"sector":"Industrials","focus_now":true,"tags":["Space","Satellite"]}',NULL,NULL,'{"latest_bar_date":"2026-06-11","expected_latest_session":"2026-06-11","is_stale":false,"source":"tradingview"}',
 'mini_chart',0,NULL,'pending','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z'),
('sample-TSEM','watchlist-review-2026-06-12','TSEM','Tower Semiconductor Ltd.','blue','keep','KEEP_CURRENT',0.8,
 '["Keep Blue after undercut and reclaim of 229.3 breakout","Latest 10.62 percent strong-volume follow-through","Semiconductor context offsets earlier volatility"]',
 '{"return_1d":10.62,"return_3d":12.9,"return_5d":15.4,"return_20d":22.8,"distance_to_20dma":9.8,"distance_to_50dma":17.6,"volume_ratio_20d":2.05,"rs20_vs_spy":15.6,"rs63_vs_spy":29.9,"cp_notes":"Undercut/reclaim of breakout level","data_source":"tradingview"}',
 '{"sector":"Technology","focus_now":true,"tags":["Semiconductors"]}',NULL,NULL,'{"latest_bar_date":"2026-06-11","expected_latest_session":"2026-06-11","is_stale":false,"source":"tradingview"}',
 'full_chart_vision',0,NULL,'pending','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z'),
('sample-ASTS','watchlist-review-2026-06-12','ASTS','AST SpaceMobile, Inc.','blue','keep','KEEP_CURRENT',0.73,
 '["Keep Blue due strong focus sector","Still worth weekend monitoring","Do not demote solely for short moving-average noise"]',
 '{"return_1d":2.1,"return_3d":3.4,"return_5d":7.8,"return_20d":19.6,"distance_to_20dma":4.7,"distance_to_50dma":12.9,"volume_ratio_20d":1.36,"rs20_vs_spy":9.3,"rs63_vs_spy":31.4,"cp_notes":"Focus-sector support remains important","data_source":"tradingview"}',
 '{"sector":"Communication Services","focus_now":true,"tags":["Space","Satellite"]}',NULL,NULL,'{"latest_bar_date":"2026-06-11","expected_latest_session":"2026-06-11","is_stale":false,"source":"tradingview"}',
 'data_only',0,NULL,'pending','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z'),
('sample-ON','watchlist-review-2026-06-12','ON','ON Semiconductor Corporation','blue','keep','KEEP_CURRENT',0.69,
 '["Keep Blue; semiconductor name holding retracement level","Strong sector support remains","Not broken enough to demote"]',
 '{"return_1d":1.5,"return_3d":-0.8,"return_5d":2.9,"return_20d":11.7,"distance_to_20dma":1.3,"distance_to_50dma":7.4,"volume_ratio_20d":1.02,"rs20_vs_spy":4.7,"rs63_vs_spy":18.5,"cp_notes":"Holding retracement after strong rally","data_source":"tradingview"}',
 '{"sector":"Technology","focus_now":true,"tags":["Semiconductors"]}',NULL,NULL,'{"latest_bar_date":"2026-06-11","expected_latest_session":"2026-06-11","is_stale":false,"source":"tradingview"}',
 'data_only',0,NULL,'pending','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z'),
('sample-COHR','watchlist-review-2026-06-12','COHR','Coherent Corp.','blue','keep','KEEP_CURRENT',0.7,
 '["Keep Blue; semiconductor-related leader holding retracement","Still constructive after strong rally","Support zone has not decisively failed"]',
 '{"return_1d":1.9,"return_3d":1.1,"return_5d":4.2,"return_20d":16.8,"distance_to_20dma":3.6,"distance_to_50dma":10.1,"volume_ratio_20d":1.08,"rs20_vs_spy":7.5,"rs63_vs_spy":25.0,"cp_notes":"Holding retracement level","data_source":"tradingview"}',
 '{"sector":"Technology","focus_now":true,"tags":["Optical","Semiconductors"]}',NULL,NULL,'{"latest_bar_date":"2026-06-11","expected_latest_session":"2026-06-11","is_stale":false,"source":"tradingview"}',
 'data_only',0,NULL,'pending','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z'),
('sample-LWLG','watchlist-review-2026-06-12','LWLG','Lightwave Logic, Inc.','yellow','blue','YELLOW_TO_BLUE',0.68,
 '["Review for Blue while holding previous breakout zone near 9","Major 10 Apr 2026 breakout of 26 percent on higher-than-average volume","High-of-day close and 4-year high break remain notable"]',
 '{"return_1d":1.0,"return_3d":3.8,"return_5d":8.2,"return_20d":18.6,"distance_to_20dma":5.9,"distance_to_50dma":21.4,"volume_ratio_20d":1.4,"rs20_vs_spy":12.6,"rs63_vs_spy":36.0,"cp_notes":"Holding prior breakout zone near 9","data_source":"tradingview"}',
 '{"sector":"Technology","focus_now":true,"tags":["Optical","Speculative Growth"]}',NULL,NULL,'{"latest_bar_date":"2026-06-11","expected_latest_session":"2026-06-11","is_stale":false,"source":"tradingview"}',
 'full_chart_vision',0,NULL,'pending','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z'),
('sample-CTVA','watchlist-review-2026-06-12','CTVA','Corteva, Inc.','yellow','keep','KEEP_CURRENT',0.63,
 '["Keep Yellow while hovering around previous breakout level near 75","No current Red trigger","Structure remains worth monitoring"]',
 '{"return_1d":0.3,"return_3d":-0.6,"return_5d":0.5,"return_20d":3.6,"distance_to_20dma":0.8,"distance_to_50dma":2.9,"volume_ratio_20d":0.92,"rs20_vs_spy":0.4,"rs63_vs_spy":5.2,"cp_notes":"Hovering around prior breakout near 75","data_source":"tradingview"}',
 '{"sector":"Materials","focus_now":false,"tags":["Agriculture"]}',NULL,NULL,'{"latest_bar_date":"2026-06-11","expected_latest_session":"2026-06-11","is_stale":false,"source":"tradingview"}',
 'data_only',0,NULL,'pending','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z'),
('sample-MEOH','watchlist-review-2026-06-12','MEOH','Methanex Corporation','yellow','keep','KEEP_CURRENT',0.6,
 '["Keep Yellow; structure not broken after 2 Mar 2026 breakout","No immediate setup yet","Still monitor until support fails"]',
 '{"return_1d":-0.2,"return_3d":0.4,"return_5d":1.2,"return_20d":2.7,"distance_to_20dma":-0.4,"distance_to_50dma":2.2,"volume_ratio_20d":0.81,"rs20_vs_spy":-0.6,"rs63_vs_spy":3.8,"cp_notes":"Post-breakout structure intact","data_source":"tradingview"}',
 '{"sector":"Materials","focus_now":false,"tags":["Chemicals"]}',NULL,NULL,'{"latest_bar_date":"2026-06-11","expected_latest_session":"2026-06-11","is_stale":false,"source":"tradingview"}',
 'data_only',0,NULL,'pending','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z'),
('sample-TGB','watchlist-review-2026-06-12','TGB','Taseko Mines Limited','yellow','keep','KEEP_CURRENT',0.58,
 '["Keep Yellow if chart is not broken below key levels","Needs visual support confirmation","Commodity context still monitorable"]',
 '{"return_1d":0.6,"return_3d":-1.5,"return_5d":-0.9,"return_20d":6.4,"distance_to_20dma":-1.2,"distance_to_50dma":3.1,"volume_ratio_20d":1.0,"rs20_vs_spy":1.4,"rs63_vs_spy":10.2,"cp_notes":"Support confirmation required","data_source":"tradingview"}',
 '{"sector":"Materials","focus_now":false,"tags":["Copper"]}',NULL,NULL,'{"latest_bar_date":"2026-06-11","expected_latest_session":"2026-06-11","is_stale":false,"source":"tradingview"}',
 'mini_chart',0,NULL,'pending','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z'),
('sample-OLDX','watchlist-review-2026-06-12','OLDX','Placeholder Broken Setup A','yellow','remove','ANY_TO_UNFLAG',0.43,
 '["Generic removal candidate requiring chart confirmation","Support invalidation must be verified before export","Do not remove if price is still holding prior breakout area"]',
 '{"return_1d":-2.2,"return_3d":-5.4,"return_5d":-7.9,"return_20d":-14.5,"distance_to_20dma":-8.6,"distance_to_50dma":-13.8,"volume_ratio_20d":1.3,"rs20_vs_spy":-12.1,"rs63_vs_spy":-19.4,"cp_notes":"Potential decisive support break; confirm visually","data_source":"tradingview"}',
 '{"sector":"Unknown","focus_now":false,"tags":["Needs Confirmation"]}',NULL,NULL,'{"latest_bar_date":"2026-06-10","expected_latest_session":"2026-06-11","is_stale":true,"source":"tradingview"}',
 'data_only',1,'Requires chart confirmation of support invalidation before removal.','pending','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z'),
('sample-DRFT','watchlist-review-2026-06-12','DRFT','Placeholder Broken Setup B','blue','unflag','ANY_TO_UNFLAG',0.41,
 '["Generic unflag candidate requiring full-chart confirmation","Messy/dead structure suspected but not final","Rollback note required before Hermes apply"]',
 '{"return_1d":-1.8,"return_3d":-4.1,"return_5d":-6.5,"return_20d":-11.2,"distance_to_20dma":-7.4,"distance_to_50dma":-10.6,"volume_ratio_20d":0.76,"rs20_vs_spy":-9.9,"rs63_vs_spy":-16.3,"cp_notes":"Potential dead structure; confirm no support offset","data_source":"tradingview"}',
 '{"sector":"Unknown","focus_now":false,"tags":["Needs Confirmation"]}',NULL,NULL,'{"latest_bar_date":"2026-06-10","expected_latest_session":"2026-06-11","is_stale":true,"source":"tradingview"}',
 'data_only',1,'Requires chart confirmation that support is invalidated and no sector offset remains.','pending','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z');
