# Peer Groups

## Schema
- `symbols`
  - reused as the canonical ticker table
  - extended with `shares_outstanding` for optional market-cap derivation
- `peer_groups`
  - durable metadata for self-managed peer collections
- `ticker_peer_groups`
  - normalized ticker-to-group memberships with provenance and confidence

## Indexes
- `symbols(ticker COLLATE NOCASE)`
- `symbols(name COLLATE NOCASE)`
- `peer_groups(slug)`
- `peer_groups(name COLLATE NOCASE)`
- `peer_groups(group_type, is_active, priority DESC, name)`
- `ticker_peer_groups(peer_group_id, ticker)`
- `ticker_peer_groups(ticker, peer_group_id)`

These keep common D1 reads bounded for:
- exact/prefix ticker lookup
- company-name search
- group member lookup
- ticker-to-membership lookup

Broad `company name contains` searches still scale with more rows read because wildcard contains matching is less index-friendly. The directory endpoint mitigates this with pagination and by returning only lightweight relational columns.

## Source Of Truth
- Finnhub and FMP are seed sources only.
- After import, D1 is the source of truth.
- Manual edits inside `/admin` own the live peer memberships.
- There is no recurring peer sync job and no runtime peer-membership dependency on Finnhub or FMP.

## Seed / Import Workflow
- Admin can trigger a seed import for a ticker from the Peer Groups admin panel.
- Admin can also trigger batch bootstrap imports, or use the local `npm run bootstrap:peers -w worker` script to keep seeding in repeated batches.
- The worker:
  - fetches peer candidates from Finnhub and FMP
  - normalizes and deduplicates symbols
  - upserts ticker metadata into `symbols`
  - stores `shares_outstanding` when already known or when fetched for the root ticker
  - creates or reuses a deterministic group like `<ticker>-fundamental-peers`
  - upserts memberships into `ticker_peer_groups`
- Batch bootstrap defaults to a low-call mode:
  - `finnhub` provider mode by default for throughput
  - no per-peer profile enrichment unless explicitly enabled
  - this keeps external calls close to one peer lookup per root ticker instead of one lookup per peer member
- Provenance values:
  - `fmp_seed`
  - `finnhub_seed`
  - `system` when multiple seed sources agree
  - `manual` for admin-edited memberships

## Runtime Metrics Strategy
- Runtime metrics come from the existing Alpaca-backed provider path.
- `/peer-groups` does not preload metrics on initial page load.
- Metrics are fetched only after a ticker is searched or selected.
- Returned fields:
  - `price`
  - `avgVolume`
  - `marketCap`
  - `asOf`
  - `source`
- `marketCap` is computed as `price * shares_outstanding` when seeded shares data exists. It remains `null` otherwise.
- No runtime metric snapshots are stored in D1.

## /peer-groups Flow
- Initial page load:
  - fetches only D1-backed directory rows and peer-group filters
  - defaults to showing seeded peer-group tickers, not every equity in `symbols`
  - no charts
  - no runtime metrics
- Search/select:
  - loads ticker detail from D1
  - loads runtime metrics from Alpaca
  - renders a multi-chart grid for the selected ticker and the active peer group

## /alerts Multi Grid Reuse
- The peer-groups chart experience reuses the same chart stack as `/alerts`.
- A shared `TickerMultiGrid` component was extracted from the `/alerts` Multi Grid pattern.
- Both `/alerts` and `/peer-groups` use:
  - `TradingViewWidget`
  - the same card/grid layout
  - the same fullscreen behavior
  - the same small-chart presentation pattern

## Admin Workflow
- `/admin` now includes a Peer Groups panel for:
  - create/edit/delete peer groups
  - search tickers
  - inspect a ticker’s memberships
  - add/remove group members
  - trigger one-time peer seeding

## Future Extension Points
- technical peer groups
- blended ranking/scoring models
- more explicit peer confidence weighting
- richer seeded fundamental metadata if needed later
