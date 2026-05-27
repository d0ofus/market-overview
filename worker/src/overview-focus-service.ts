import type { Env } from "./types";

const DEFAULT_CONFIG_ID = "default";
const MAX_FOCUS_TEXT_LENGTH = 280;
const MAX_ACTIVE_FOCUS_ITEMS = 12;
const DEFAULT_HISTORY_LIMIT = 50;

export type OverviewFocusItem = {
  id: string;
  configId: string;
  text: string;
  sortOrder: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OverviewFocusHistoryItem = {
  text: string;
  lastUsedAt: string;
};

type OverviewFocusRow = {
  id: string;
  configId: string;
  text: string;
  sortOrder: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type OverviewFocusHistoryRow = {
  text: string;
  lastUsedAt: string;
};

export class OverviewFocusError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "OverviewFocusError";
    this.status = status;
  }
}

function configIdFromInput(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_CONFIG_ID;
}

function compactText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeFocusText(value: unknown): string {
  if (typeof value !== "string") throw new OverviewFocusError("Focus text is required.");
  const text = compactText(value);
  if (!text) throw new OverviewFocusError("Focus text is required.");
  if (text.length > MAX_FOCUS_TEXT_LENGTH) {
    throw new OverviewFocusError(`Focus text must be ${MAX_FOCUS_TEXT_LENGTH} characters or fewer.`);
  }
  return text;
}

function normalizedKey(text: string): string {
  return compactText(text).toLocaleLowerCase("en-US");
}

function isOverviewFocusSchemaMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
  return message.includes("overview_focus_items") && (message.includes("no such table") || message.includes("not found"));
}

function mapRow(row: OverviewFocusRow): OverviewFocusItem {
  return {
    id: row.id,
    configId: row.configId,
    text: row.text,
    sortOrder: Number(row.sortOrder ?? 0),
    deletedAt: row.deletedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadActiveFocusItem(env: Env, id: string): Promise<OverviewFocusItem | null> {
  const row = await env.DB.prepare(
    `SELECT
       id,
       config_id as configId,
       text,
       sort_order as sortOrder,
       deleted_at as deletedAt,
       created_at as createdAt,
       updated_at as updatedAt
     FROM overview_focus_items
     WHERE id = ? AND deleted_at IS NULL
     LIMIT 1`,
  )
    .bind(id)
    .first<OverviewFocusRow>();
  return row ? mapRow(row) : null;
}

async function findActiveDuplicate(env: Env, configId: string, textNormalized: string, excludeId?: string): Promise<string | null> {
  const row = excludeId
    ? await env.DB.prepare(
        "SELECT id FROM overview_focus_items WHERE config_id = ? AND text_normalized = ? AND deleted_at IS NULL AND id <> ? LIMIT 1",
      )
        .bind(configId, textNormalized, excludeId)
        .first<{ id: string }>()
    : await env.DB.prepare(
        "SELECT id FROM overview_focus_items WHERE config_id = ? AND text_normalized = ? AND deleted_at IS NULL LIMIT 1",
      )
        .bind(configId, textNormalized)
        .first<{ id: string }>();
  return row?.id ?? null;
}

export async function listOverviewFocusItems(env: Env, configIdInput?: string | null): Promise<OverviewFocusItem[]> {
  const configId = configIdFromInput(configIdInput);
  try {
    const rows = await env.DB.prepare(
      `SELECT
         id,
         config_id as configId,
         text,
         sort_order as sortOrder,
         deleted_at as deletedAt,
         created_at as createdAt,
         updated_at as updatedAt
       FROM overview_focus_items
       WHERE config_id = ? AND deleted_at IS NULL
       ORDER BY sort_order ASC, created_at ASC, id ASC`,
    )
      .bind(configId)
      .all<OverviewFocusRow>();
    return (rows.results ?? []).map(mapRow);
  } catch (error) {
    if (isOverviewFocusSchemaMissing(error)) return [];
    throw error;
  }
}

export async function listOverviewFocusHistory(
  env: Env,
  configIdInput?: string | null,
  limitInput = DEFAULT_HISTORY_LIMIT,
): Promise<OverviewFocusHistoryItem[]> {
  const configId = configIdFromInput(configIdInput);
  const limit = Math.max(1, Math.min(100, Math.floor(limitInput || DEFAULT_HISTORY_LIMIT)));
  try {
    const rows = await env.DB.prepare(
      `SELECT
         focus.text as text,
         focus.updated_at as lastUsedAt
       FROM overview_focus_items focus
       WHERE focus.config_id = ?
         AND NOT EXISTS (
           SELECT 1
           FROM overview_focus_items newer
           WHERE newer.config_id = focus.config_id
             AND newer.text_normalized = focus.text_normalized
             AND (
               newer.updated_at > focus.updated_at
               OR (newer.updated_at = focus.updated_at AND newer.created_at > focus.created_at)
               OR (newer.updated_at = focus.updated_at AND newer.created_at = focus.created_at AND newer.id > focus.id)
             )
         )
       ORDER BY focus.updated_at DESC, focus.created_at DESC, focus.id DESC
       LIMIT ?`,
    )
      .bind(configId, limit)
      .all<OverviewFocusHistoryRow>();
    return (rows.results ?? []).map((row) => ({
      text: row.text,
      lastUsedAt: row.lastUsedAt,
    }));
  } catch (error) {
    if (isOverviewFocusSchemaMissing(error)) return [];
    throw error;
  }
}

export async function createOverviewFocusItem(env: Env, input: unknown): Promise<OverviewFocusItem> {
  const payload = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const configId = configIdFromInput(payload.configId);
  const text = normalizeFocusText(payload.text);
  const textNormalized = normalizedKey(text);

  const duplicateId = await findActiveDuplicate(env, configId, textNormalized);
  if (duplicateId) throw new OverviewFocusError("That focus is already active.", 409);

  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM overview_focus_items WHERE config_id = ? AND deleted_at IS NULL",
  )
    .bind(configId)
    .first<{ count: number }>();
  if (Number(countRow?.count ?? 0) >= MAX_ACTIVE_FOCUS_ITEMS) {
    throw new OverviewFocusError(`Overview supports up to ${MAX_ACTIVE_FOCUS_ITEMS} active focus items.`);
  }

  const sortRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) + 1 as nextSort FROM overview_focus_items WHERE config_id = ? AND deleted_at IS NULL",
  )
    .bind(configId)
    .first<{ nextSort: number }>();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO overview_focus_items
       (id, config_id, text, text_normalized, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  )
    .bind(id, configId, text, textNormalized, Number(sortRow?.nextSort ?? 0))
    .run();

  const created = await loadActiveFocusItem(env, id);
  if (!created) throw new Error("Failed to create overview focus item.");
  return created;
}

export async function updateOverviewFocusItem(env: Env, id: string, input: unknown): Promise<OverviewFocusItem> {
  const existing = await loadActiveFocusItem(env, id);
  if (!existing) throw new OverviewFocusError("Overview focus item not found.", 404);

  const payload = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const text = normalizeFocusText(payload.text);
  const textNormalized = normalizedKey(text);

  const duplicateId = await findActiveDuplicate(env, existing.configId, textNormalized, id);
  if (duplicateId) throw new OverviewFocusError("That focus is already active.", 409);

  await env.DB.prepare(
    `UPDATE overview_focus_items
     SET text = ?, text_normalized = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(text, textNormalized, id)
    .run();

  const updated = await loadActiveFocusItem(env, id);
  if (!updated) throw new Error("Failed to update overview focus item.");
  return updated;
}

export async function deleteOverviewFocusItem(env: Env, id: string): Promise<OverviewFocusItem> {
  const existing = await loadActiveFocusItem(env, id);
  if (!existing) throw new OverviewFocusError("Overview focus item not found.", 404);

  await env.DB.prepare(
    `UPDATE overview_focus_items
     SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(id)
    .run();
  return existing;
}
