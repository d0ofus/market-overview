# Optional rate probabilities

RateProbability remains independent of official New York Fed rate facts and FOMC commentary. Public `/api/fedwatch` reads stored data; it does not contact providers. `probabilitySource` reports the last attempt, last success, sanitized error, next retry, and expired meeting count.

Refresh ownership and cooldown persist in Core's existing `provider_symbol_backoff` table under `rateprobability` / `FEDFUNDS`. No migration or additional binding is required. A two-minute lease prevents concurrent refreshes; snapshot insertion checks that ownership again. Successful collection waits one hour before another request, including when the provider still serves an older source date.

Each request has a five-second timeout. Network failures and HTTP 500/502/503/504 allow one retry after 500 ms. Failed cycles wait 30 minutes, increasing to six hours. HTTP 401/403 waits 24 hours; HTTP 429 honors bounded `Retry-After` between one and 24 hours. Forced refresh does not bypass these limits.

Applicable last-good prices retain their original source and collection dates. Meetings disappear at 14:00 New York on their decision date, including on an already-open browser page. If no future references remain, probabilities become unavailable while official facts remain visible. Missing comparison points stay gaps. A failed or malformed response never updates the last-good snapshot's age.
