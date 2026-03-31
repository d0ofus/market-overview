UPDATE prompt_versions
SET model_family = 'claude-3-5-haiku-20241022'
WHERE id = 'prompt-haiku-extract-v2'
  AND model_family IN ('claude-3-haiku-20240307', 'claude-3-5-haiku-latest');

UPDATE prompt_versions
SET model_family = 'claude-3-7-sonnet-latest'
WHERE id = 'prompt-sonnet-rank-v2'
  AND model_family IN ('claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20240620', 'claude-3-sonnet-20240229');

UPDATE prompt_versions
SET model_family = 'claude-3-7-sonnet-latest'
WHERE id = 'prompt-sonnet-deep-dive-v2'
  AND model_family IN ('claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20240620', 'claude-3-sonnet-20240229');
