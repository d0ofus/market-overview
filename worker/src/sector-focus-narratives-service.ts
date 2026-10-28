import type { SectorFocusNarrativeCreateInput } from "./validation";

export const FOCUS_TICKER_PATTERN = /^[A-Z.\-^]{1,20}$/;

export type FocusSourceUniverse = {
  narrativeName: string | null;
  narrativeTickers: string[];
  peerGroupId: string | null;
  peerGroupName: string | null;
  peerGroupTickers: string[];
};

export type FocusNameInput = FocusSourceUniverse & {
  manualName: string | null;
  selectedTickers: string[];
};

export type FocusNameResult = {
  sectorName: string;
  manualName: string | null;
  selectedTickers: string[];
  requiresManualName: boolean;
};

export class FocusNarrativeValidationError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "FocusNarrativeValidationError";
  }
}

type FocusNarrativeRow = {
  id: string;
  sectorName: string;
  sortOrder: number;
  comment: string;
  sourceNarrativeName: string | null;
  sourcePeerGroupId: string | null;
  sourcePeerGroupName: string | null;
  manualName: string | null;
  selectedTickers: Array<{ ticker: string; name: string | null }>;
  createdAt: string;
  updatedAt: string;
};

export async function createFocusNarrative(
  db: D1Database,
  input: SectorFocusNarrativeCreateInput,
): Promise<FocusNarrativeRow> {
  const narrativeRows = input.sourceNarrativeName
    ? (await db.prepare(
      `SELECT es.ticker
       FROM sector_tracker_entries e
       LEFT JOIN sector_tracker_entry_symbols es ON es.entry_id = e.id
       WHERE e.sector_name = ?`,
    ).bind(input.sourceNarrativeName).all<{ ticker: string | null }>()).results
    : [];
  if (input.sourceNarrativeName && narrativeRows.length === 0) {
    throw new FocusNarrativeValidationError(`Narrative not found: ${input.sourceNarrativeName}`, 404);
  }
  const peerRows = input.sourcePeerGroupId
    ? (await db.prepare(
      `SELECT pg.name, tpg.ticker
       FROM peer_groups pg
       LEFT JOIN ticker_peer_groups tpg ON tpg.peer_group_id = pg.id
       WHERE pg.id = ? AND pg.is_active = 1`,
    ).bind(input.sourcePeerGroupId).all<{ name: string; ticker: string | null }>()).results
    : [];
  if (input.sourcePeerGroupId && peerRows.length === 0) {
    throw new FocusNarrativeValidationError(`Peer group not found: ${input.sourcePeerGroupId}`, 404);
  }
  const named = deriveFocusNarrativeName({
    narrativeName: input.sourceNarrativeName,
    narrativeTickers: normalizeFocusTickers(narrativeRows.map((row) => row.ticker)),
    peerGroupId: input.sourcePeerGroupId,
    peerGroupName: peerRows[0]?.name ?? null,
    peerGroupTickers: normalizeFocusTickers(peerRows.map((row) => row.ticker)),
    manualName: input.manualName,
    selectedTickers: input.selectedTickers,
  });
  const duplicateError = () => new FocusNarrativeValidationError(
    `Focus Now already contains an entry named ${named.sectorName}.`, 409,
  );
  const existingNames = await db.prepare("SELECT sector_name as sectorName FROM sector_focus_narratives")
    .all<{ sectorName: string }>();
  if (existingNames.results.some((row) => row.sectorName.toLocaleLowerCase() === named.sectorName.toLocaleLowerCase())) {
    throw duplicateError();
  }

  const id = crypto.randomUUID();
  const tickersJson = JSON.stringify(named.selectedTickers);
  const results = await db.batch([
    // Check duplicates and allocate the append position within the insert, so
    // concurrent creations cannot overwrite entries or reuse a sort position.
    db.prepare(
      `INSERT INTO sector_focus_narratives
        (id, sector_name, sort_order, comment_text, source_narrative_name, source_peer_group_id, manual_name)
       SELECT ?, ?, COALESCE(MAX(sort_order), -1) + 1, ?, ?, ?, ?
       FROM sector_focus_narratives
       HAVING NOT EXISTS (
         SELECT 1 FROM sector_focus_narratives WHERE LOWER(sector_name) = LOWER(?)
       )`,
    ).bind(id, named.sectorName, input.comment, input.sourceNarrativeName, input.sourcePeerGroupId, named.manualName, named.sectorName),
    // If the duplicate guard skipped the parent, these inserts also do nothing.
    db.prepare(
      `INSERT OR IGNORE INTO symbols (ticker, name, asset_class)
       SELECT CAST(value AS TEXT), CAST(value AS TEXT), 'stock'
       FROM json_each(?)
       WHERE EXISTS (SELECT 1 FROM sector_focus_narratives WHERE id = ?)`,
    ).bind(tickersJson, id),
    db.prepare(
      `INSERT INTO sector_focus_narrative_symbols (focus_narrative_id, ticker, sort_order)
       SELECT ?, CAST(value AS TEXT), CAST(key AS INTEGER)
       FROM json_each(?)
       WHERE EXISTS (SELECT 1 FROM sector_focus_narratives WHERE id = ?)`,
    ).bind(id, tickersJson, id),
  ]);
  if (results[0].meta.changes === 0) throw duplicateError();

  const row = await db.prepare(
    `SELECT f.id, f.sector_name as sectorName, f.sort_order as sortOrder,
       COALESCE(f.comment_text, '') as comment,
       f.source_narrative_name as sourceNarrativeName,
       f.source_peer_group_id as sourcePeerGroupId,
       pg.name as sourcePeerGroupName, f.manual_name as manualName,
       f.created_at as createdAt, f.updated_at as updatedAt
     FROM sector_focus_narratives f
     LEFT JOIN peer_groups pg ON pg.id = f.source_peer_group_id
     WHERE f.id = ?`,
  ).bind(id).first<Omit<FocusNarrativeRow, "selectedTickers">>();
  if (!row) throw new Error("Created Focus Now entry could not be loaded.");
  const links = await db.prepare(
    `SELECT fs.ticker, s.name
     FROM sector_focus_narrative_symbols fs
     LEFT JOIN symbols s ON s.ticker = fs.ticker
     WHERE fs.focus_narrative_id = ?
     ORDER BY fs.sort_order ASC, fs.ticker ASC`,
  ).bind(id).all<{ ticker: string; name: string | null }>();
  return { ...row, selectedTickers: links.results };
}

export async function deleteFocusNarrative(db: D1Database, id: string): Promise<void> {
  const existing = await db.prepare("SELECT id FROM sector_focus_narratives WHERE id = ? LIMIT 1")
    .bind(id)
    .first<{ id: string }>();
  if (!existing) throw new FocusNarrativeValidationError("Focus narrative not found.", 404);

  await db.batch([
    db.prepare("DELETE FROM sector_focus_narrative_symbols WHERE focus_narrative_id = ?").bind(id),
    db.prepare("DELETE FROM sector_focus_narratives WHERE id = ?").bind(id),
  ]);
}

export function normalizeFocusTickers(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(
    values
      .map((value) => (typeof value === "string" ? value.trim().toUpperCase() : ""))
      .filter((value) => FOCUS_TICKER_PATTERN.test(value)),
  ));
}

function isSubset(values: string[], universe: string[]): boolean {
  if (values.length === 0) return false;
  const universeSet = new Set(normalizeFocusTickers(universe));
  return values.every((ticker) => universeSet.has(ticker));
}

export function deriveFocusNarrativeName(input: FocusNameInput): FocusNameResult {
  const selectedTickers = normalizeFocusTickers(input.selectedTickers);
  if (selectedTickers.length === 0) {
    throw new FocusNarrativeValidationError("At least one ticker must be selected.");
  }

  const narrativeName = input.narrativeName?.trim() || null;
  const peerGroupName = input.peerGroupName?.trim() || null;
  const manualName = input.manualName?.trim() || null;
  const inNarrative = Boolean(narrativeName) && isSubset(selectedTickers, input.narrativeTickers);
  const inPeerGroup = Boolean(input.peerGroupId && peerGroupName) && isSubset(selectedTickers, input.peerGroupTickers);

  // Peer group wins the deliberate overlap case.
  if (inPeerGroup) {
    return { sectorName: peerGroupName!, manualName, selectedTickers, requiresManualName: false };
  }
  if (inNarrative) {
    return { sectorName: narrativeName!, manualName, selectedTickers, requiresManualName: false };
  }
  if (!manualName) {
    throw new FocusNarrativeValidationError(
      "Entry name is required when selected tickers mix sources or fall outside the selected narrative or peer group.",
    );
  }
  return { sectorName: manualName, manualName, selectedTickers, requiresManualName: true };
}
