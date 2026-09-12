# Current archive capacity measurement

The optional `--current-archive-context-json` analyzer input selects
`verified-current-archive-forecast-v1`. The original cold-source model is
unchanged when that input is absent. A caller must authenticate the durable
archive receipt, execution lineage, whole population, original source backup,
and separately verified source-copy count before creating this context.

The local source backup can predate the frozen source copy. `archive.sourceRows`
is the count actually present in that backup; `archive.verifiedCopySourceRows`
comes from the independently authenticated copy proof. The current-archive
model does not overlay old source observations onto accepted archive revisions,
and reports `checkedSourceRows: 0` and `sourceOverlayApplied: false` explicitly.
The original source file, copy proof, parity results, and dates remain unchanged.
The source snapshot identity remains the original plan's normalized SQLite
backup hash; a raw file header can have a different change counter. The archive
receipt separately binds the actual completed archive file SHA-256.

The model starts with the complete captured archive, verifies every block and
both current and previous pointers, and requires the actual two pointer indexes.
It includes unpointed blocks. It fills a 260-session daily primary history plus 40
future cached equity-session storage slots for every shared security, and 320 observations
for all reserved Yahoo identities, up to the unchanged 1,000-identity limit.
These are temporary capacity fixtures, never market observations. Existing older
dates remain present. Deep maintenance and explicit history jobs share an enforced
UTC-week limit of four securities and 2,500 requested or rechecked observations.
Each supported deep-history request covers at least 520 sessions, so the
observation allowance already permits at most four new securities per week.
The model reserves the entire limit for every week intersecting the 40-session
forecast, including the starting partial week. This preserves requested 520/1,400
session depths; work exceeding the budget is deferred, rather than truncated.

Two distinct revision generations use the application's codec and actual
SQLite schema. Each insertion is read back before a conditional pointer change;
only the superseded, unreferenced previous revision is deleted. Originally
unpointed blocks are retained. The model records the maximum physical SQLite
allocation during insertion and pointer change, without `VACUUM`. Disabling
durable journal flushing applies only to the disposable simulation; it changes
neither B-tree allocation nor foreign-key validation.

The projection adds a dated positive live-minus-logical-capture allocation
allowance, a finite failed-write allowance of at least 4 MiB (or the 25 largest
modeled candidate allocations), and another 4 MiB transient allowance. This is
an operational forecast of measured current values and full-width missing and
future fixtures. It does not promise unlimited failed retries or arbitrary
future provider-value entropy. Recoverable capacity failures remain visible.
Future observations use their individual session dates and millisecond collection
timestamps, including a later raw-volume collection time; they are not compressed
as though all future sessions arrived in one historical request.
Fresh production physical measurements, actual publication growth, and all
ordinary acceptance checks are still required. The 350,000,000-byte limit is
unchanged; a forecast over that limit must be rejected.

An expansion capture can remain the authenticated baseline for subsequent
acceptance if its forecast covers the new writer and fresh live measurements
remain within the approved projection. Reuse preserves its original file hash,
capture time, and context; it does not claim that an old capture was taken again.
Final controller configuration must point to that authenticated complete
archive file, not an earlier capacity-only snapshot.
