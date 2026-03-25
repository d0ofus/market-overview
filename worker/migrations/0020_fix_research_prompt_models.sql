UPDATE prompt_versions
SET model_family = 'claude-3-haiku-20240307'
WHERE id = 'prompt-haiku-extract-v1'
  AND model_family IN ('haiku-4.5', 'claude-3-5-haiku-latest');

UPDATE prompt_versions
SET model_family = 'claude-3-haiku-20240307'
WHERE id = 'prompt-sonnet-rank-v1'
  AND model_family IN ('sonnet-4.6', 'claude-3-7-sonnet-latest', 'claude-3-5-sonnet-20240620', 'claude-3-5-sonnet-20241022', 'claude-3-sonnet-20240229');

UPDATE prompt_versions
SET model_family = 'claude-3-haiku-20240307'
WHERE id = 'prompt-sonnet-deep-dive-v1'
  AND model_family IN ('sonnet-4.6', 'claude-3-7-sonnet-latest', 'claude-3-5-sonnet-20240620', 'claude-3-5-sonnet-20241022', 'claude-3-sonnet-20240229');
