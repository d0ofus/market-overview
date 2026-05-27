import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

type FocusRow = {
  id: string;
  configId: string;
  text: string;
  textNormalized: string;
  sortOrder: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function normalizeKey(text: string): string {
  return normalizeText(text).toLocaleLowerCase("en-US");
}

function createOverviewFocusEnv(input: { rows?: FocusRow[]; adminSecret?: string } = {}): Env & { __rows: FocusRow[] } {
  const rows = [...(input.rows ?? [])];
  let stampCounter = 0;
  const stamp = () => `2026-05-27T00:00:${String(++stampCounter).padStart(2, "0")}Z`;

  const activeRows = (configId: string) =>
    rows
      .filter((row) => row.configId === configId && row.deletedAt == null)
      .sort((left, right) =>
        left.sortOrder - right.sortOrder ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
      );

  const historyRows = (configId: string) => {
    const latestByKey = new Map<string, FocusRow>();
    for (const row of rows.filter((entry) => entry.configId === configId)) {
      const current = latestByKey.get(row.textNormalized);
      if (
        !current ||
        row.updatedAt > current.updatedAt ||
        (row.updatedAt === current.updatedAt && row.createdAt > current.createdAt) ||
        (row.updatedAt === current.updatedAt && row.createdAt === current.createdAt && row.id > current.id)
      ) {
        latestByKey.set(row.textNormalized, row);
      }
    }
    return Array.from(latestByKey.values()).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id),
    );
  };

  const statementFor = (sql: string, args: unknown[] = []): any => ({
    __sql: sql,
    __args: args,
    bind(...nextArgs: unknown[]) {
      return statementFor(sql, nextArgs);
    },
    async all<T>() {
      if (sql.includes("FROM overview_focus_items") && sql.includes("ORDER BY sort_order")) {
        const configId = String(args[0] ?? "default");
        return { results: activeRows(configId).map((row) => ({
          id: row.id,
          configId: row.configId,
          text: row.text,
          sortOrder: row.sortOrder,
          deletedAt: row.deletedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })) as T[] };
      }

      if (sql.includes("FROM overview_focus_items focus") && sql.includes("NOT EXISTS")) {
        const configId = String(args[0] ?? "default");
        const limit = Number(args[1] ?? 50);
        return { results: historyRows(configId).slice(0, limit).map((row) => ({
          text: row.text,
          lastUsedAt: row.updatedAt,
        })) as T[] };
      }

      return { results: [] as T[] };
    },
    async first<T>() {
      if (sql.includes("SELECT COUNT(*) as count FROM overview_focus_items")) {
        return { count: activeRows(String(args[0] ?? "default")).length } as T;
      }

      if (sql.includes("SELECT COALESCE(MAX(sort_order), -1) + 1 as nextSort")) {
        const current = activeRows(String(args[0] ?? "default"));
        const maxSort = current.reduce((max, row) => Math.max(max, row.sortOrder), -1);
        return { nextSort: maxSort + 1 } as T;
      }

      if (sql.includes("SELECT id FROM overview_focus_items WHERE config_id = ? AND text_normalized = ?")) {
        const configId = String(args[0] ?? "default");
        const textNormalized = String(args[1] ?? "");
        const excludeId = sql.includes("id <> ?") ? String(args[2] ?? "") : null;
        const row = activeRows(configId).find((entry) => entry.textNormalized === textNormalized && entry.id !== excludeId);
        return (row ? { id: row.id } : null) as T;
      }

      if (sql.includes("FROM overview_focus_items") && sql.includes("WHERE id = ? AND deleted_at IS NULL")) {
        const row = rows.find((entry) => entry.id === args[0] && entry.deletedAt == null);
        return (row ? {
          id: row.id,
          configId: row.configId,
          text: row.text,
          sortOrder: row.sortOrder,
          deletedAt: row.deletedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        } : null) as T;
      }

      return null as T;
    },
    async run() {
      if (sql.includes("INSERT INTO overview_focus_items")) {
        const [id, configId, text, textNormalized, sortOrder] = args;
        const now = stamp();
        rows.push({
          id: String(id),
          configId: String(configId),
          text: String(text),
          textNormalized: String(textNormalized),
          sortOrder: Number(sortOrder),
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        });
      } else if (sql.includes("SET text = ?")) {
        const [text, textNormalized, id] = args;
        const row = rows.find((entry) => entry.id === id && entry.deletedAt == null);
        if (row) {
          row.text = String(text);
          row.textNormalized = String(textNormalized);
          row.updatedAt = stamp();
        }
      } else if (sql.includes("SET deleted_at = CURRENT_TIMESTAMP")) {
        const [id] = args;
        const row = rows.find((entry) => entry.id === id && entry.deletedAt == null);
        if (row) {
          const now = stamp();
          row.deletedAt = now;
          row.updatedAt = now;
        }
      }
      return { success: true, meta: { changes: 1 } };
    },
  });

  return {
    ADMIN_SECRET: input.adminSecret,
    DB: {
      prepare(sql: string) {
        return statementFor(sql);
      },
      async batch() {
        return [];
      },
    } as unknown as D1Database,
    __rows: rows,
  } as Env & { __rows: FocusRow[] };
}

function seedRow(id: string, text: string, sortOrder: number, deletedAt: string | null = null): FocusRow {
  return {
    id,
    configId: "default",
    text,
    textNormalized: normalizeKey(text),
    sortOrder,
    deletedAt,
    createdAt: `2026-05-27T00:${String(sortOrder).padStart(2, "0")}:00Z`,
    updatedAt: deletedAt ?? `2026-05-27T00:${String(sortOrder).padStart(2, "0")}:00Z`,
  };
}

async function adminFetch(env: Env, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer secret");
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers,
    }),
    env,
    {} as ExecutionContext,
  );
}

describe("overview focus API", () => {
  it("returns an empty public focus list and history before any inputs exist", async () => {
    const env = createOverviewFocusEnv();

    const active = await worker.fetch(new Request("http://localhost/api/overview/focus"), env, {} as ExecutionContext);
    const history = await worker.fetch(new Request("http://localhost/api/overview/focus/history"), env, {} as ExecutionContext);

    expect(active.status).toBe(200);
    expect(await active.json()).toEqual({ rows: [] });
    expect(history.status).toBe(200);
    expect(await history.json()).toEqual({ rows: [] });
  });

  it("creates, updates, and soft-deletes active focus items", async () => {
    const env = createOverviewFocusEnv({ adminSecret: "secret" });

    const createdResponse = await adminFetch(env, "/api/admin/overview-focus", {
      method: "POST",
      body: JSON.stringify({ text: "  Focus on retracements   in strong markets  " }),
    });
    const created = await createdResponse.json() as { item: FocusRow };
    expect(createdResponse.status).toBe(200);
    expect(created.item.text).toBe("Focus on retracements in strong markets");

    const updatedResponse = await adminFetch(env, `/api/admin/overview-focus/${created.item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ text: "Monitor earnings gappers/surprises" }),
    });
    const updated = await updatedResponse.json() as { item: FocusRow };
    expect(updatedResponse.status).toBe(200);
    expect(updated.item.text).toBe("Monitor earnings gappers/surprises");

    const deletedResponse = await adminFetch(env, `/api/admin/overview-focus/${created.item.id}`, { method: "DELETE" });
    expect(deletedResponse.status).toBe(200);
    expect(env.__rows[0]?.deletedAt).not.toBeNull();

    const active = await worker.fetch(new Request("http://localhost/api/overview/focus"), env, {} as ExecutionContext);
    expect(await active.json()).toEqual({ rows: [] });
  });

  it("keeps deleted focus text in history and allows it to be re-added as a new active item", async () => {
    const env = createOverviewFocusEnv({
      adminSecret: "secret",
      rows: [seedRow("old-focus", "Monitor earnings gappers/surprises", 0)],
    });

    const deletedResponse = await adminFetch(env, "/api/admin/overview-focus/old-focus", { method: "DELETE" });
    expect(deletedResponse.status).toBe(200);

    const historyResponse = await worker.fetch(new Request("http://localhost/api/overview/focus/history"), env, {} as ExecutionContext);
    const history = await historyResponse.json() as { rows: Array<{ text: string }> };
    expect(history.rows.map((row) => row.text)).toEqual(["Monitor earnings gappers/surprises"]);

    const reactivatedResponse = await adminFetch(env, "/api/admin/overview-focus", {
      method: "POST",
      body: JSON.stringify({ text: "Monitor earnings gappers/surprises" }),
    });
    const reactivated = await reactivatedResponse.json() as { item: FocusRow };
    expect(reactivatedResponse.status).toBe(200);
    expect(reactivated.item.id).not.toBe("old-focus");

    const activeResponse = await worker.fetch(new Request("http://localhost/api/overview/focus"), env, {} as ExecutionContext);
    const active = await activeResponse.json() as { rows: FocusRow[] };
    expect(active.rows.map((row) => row.text)).toEqual(["Monitor earnings gappers/surprises"]);
  });

  it("requires admin auth for mutations when ADMIN_SECRET is configured", async () => {
    const env = createOverviewFocusEnv({ adminSecret: "secret" });

    const response = await worker.fetch(
      new Request("http://localhost/api/admin/overview-focus", {
        method: "POST",
        body: JSON.stringify({ text: "Focus on breakouts" }),
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(401);
    expect(env.__rows).toEqual([]);
  });

  it("rejects blank, too-long, duplicate-active, and over-limit inputs", async () => {
    const env = createOverviewFocusEnv({
      adminSecret: "secret",
      rows: [seedRow("active-focus", "Focus on retracements", 0)],
    });

    const blank = await adminFetch(env, "/api/admin/overview-focus", {
      method: "POST",
      body: JSON.stringify({ text: "   " }),
    });
    expect(blank.status).toBe(400);

    const tooLong = await adminFetch(env, "/api/admin/overview-focus", {
      method: "POST",
      body: JSON.stringify({ text: "x".repeat(281) }),
    });
    expect(tooLong.status).toBe(400);

    const duplicate = await adminFetch(env, "/api/admin/overview-focus", {
      method: "POST",
      body: JSON.stringify({ text: " focus   on retracements " }),
    });
    expect(duplicate.status).toBe(409);

    const limitEnv = createOverviewFocusEnv({
      adminSecret: "secret",
      rows: Array.from({ length: 12 }, (_, index) => seedRow(`focus-${index}`, `Focus ${index}`, index)),
    });
    const overLimit = await adminFetch(limitEnv, "/api/admin/overview-focus", {
      method: "POST",
      body: JSON.stringify({ text: "One more focus" }),
    });
    expect(overLimit.status).toBe(400);
  });
});
