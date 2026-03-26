UPDATE research_profile_versions
SET settings_json = '{
  "lookbackDays": 14,
  "includeMacroContext": true,
  "maxTickerQueries": 5,
  "maxEvidenceItemsPerTicker": 14,
  "maxSearchResultsPerQuery": 4,
  "maxTickersPerRun": 20,
  "deepDiveTopN": 3,
  "comparisonEnabled": true,
  "peerComparisonEnabled": true,
  "maxPeerCandidates": 3,
  "maxTopicEvidenceItems": 4,
  "maxEvidenceExcerptsPerTopic": 2,
  "sourceFamilies": {
    "sec": true,
    "news": true,
    "earningsTranscripts": true,
    "investorRelations": true,
    "analystCommentary": true
  }
}'
WHERE id = 'research-profile-swing-core-v2';
