"use client";

import { useMemo, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Check, Plus, Pencil, Target, Trash2, X } from "lucide-react";
import {
  createOverviewFocusItem,
  deleteOverviewFocusItem,
  getOverviewFocusHistory,
  getOverviewFocusItems,
  updateOverviewFocusItem,
  type OverviewFocusHistoryItem,
  type OverviewFocusItem,
} from "@/lib/api";

type Props = {
  initialItems: OverviewFocusItem[];
  initialHistory: OverviewFocusHistoryItem[];
  configId?: string;
  anchorId?: string;
};

function normalizeClientText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeClientKey(value: string): string {
  return normalizeClientText(value).toLocaleLowerCase("en-US");
}

function buttonClass(tone: "quiet" | "accent" | "danger" = "quiet"): string {
  if (tone === "accent") {
    return "inline-flex h-9 w-9 items-center justify-center rounded-xl border border-accent/40 bg-accent/15 text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50";
  }
  if (tone === "danger") {
    return "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-borderSoft/70 bg-panelSoft/35 text-slate-400 transition hover:border-danger/40 hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-50";
  }
  return "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-borderSoft/70 bg-panelSoft/35 text-slate-400 transition hover:bg-panelSoft/60 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50";
}

export function CurrentFocusPanel({ initialItems, initialHistory, configId = "default", anchorId }: Props) {
  const [items, setItems] = useState(initialItems);
  const [history, setHistory] = useState(initialHistory);
  const [draft, setDraft] = useState("");
  const [selectedHistoryText, setSelectedHistoryText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "danger"; text: string } | null>(null);

  const activeKeys = useMemo(() => new Set(items.map((item) => normalizeClientKey(item.text))), [items]);

  async function syncFocusData() {
    const [nextItems, nextHistory] = await Promise.all([
      getOverviewFocusItems(configId),
      getOverviewFocusHistory(configId),
    ]);
    setItems(nextItems.rows ?? []);
    setHistory(nextHistory.rows ?? []);
  }

  function showError(error: unknown, fallback: string) {
    setMessage({ tone: "danger", text: error instanceof Error ? error.message : fallback });
  }

  async function submitFocus(event: FormEvent) {
    event.preventDefault();
    const nextText = normalizeClientText(draft || selectedHistoryText);
    if (!nextText) {
      setMessage({ tone: "danger", text: "Enter or select a focus." });
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const created = await createOverviewFocusItem(nextText, configId);
      setItems((current) => [...current, created.item].sort((left, right) => left.sortOrder - right.sortOrder));
      setDraft("");
      setSelectedHistoryText("");
      await syncFocusData();
    } catch (error) {
      showError(error, "Failed to add focus.");
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit(id: string) {
    const nextText = normalizeClientText(editingText);
    if (!nextText) {
      setMessage({ tone: "danger", text: "Focus text is required." });
      return;
    }

    setBusyId(id);
    setMessage(null);
    try {
      const updated = await updateOverviewFocusItem(id, nextText);
      setItems((current) => current.map((item) => (item.id === id ? updated.item : item)));
      setEditingId(null);
      setEditingText("");
      await syncFocusData();
    } catch (error) {
      showError(error, "Failed to update focus.");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteFocus(id: string) {
    setBusyId(id);
    setMessage(null);
    try {
      await deleteOverviewFocusItem(id);
      setItems((current) => current.filter((item) => item.id !== id));
      await syncFocusData();
    } catch (error) {
      showError(error, "Failed to delete focus.");
    } finally {
      setBusyId(null);
    }
  }

  function handleDraftKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setDraft("");
      setSelectedHistoryText("");
      setMessage(null);
    }
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLInputElement>, id: string) {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveEdit(id);
    }
    if (event.key === "Escape") {
      setEditingId(null);
      setEditingText("");
    }
  }

  return (
    <section id={anchorId} className="card scroll-mt-28 overflow-visible p-3 md:scroll-mt-32 md:p-4 xl:h-fit">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent">Current Focus</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold leading-tight text-slate-100 md:text-2xl">Market Playbook</h2>
            <span className="inline-flex h-6 items-center rounded-full border border-accent/30 bg-accent/10 px-2.5 text-xs font-semibold text-accent">
              {items.length} active
            </span>
          </div>
        </div>
      </div>

      <div className="mt-3 space-y-3">
        <div className="min-w-0">
          {items.length === 0 ? (
            <div className="rounded-xl border border-dashed border-borderSoft/80 bg-panelSoft/25 px-3 py-3 text-sm text-slate-400">
              No active focus set.
            </div>
          ) : (
            <div className="grid gap-2">
              {items.map((item) => {
                const isEditing = editingId === item.id;
                const isBusy = busyId === item.id;
                return (
                  <article
                    key={item.id}
                    className="group relative grid min-w-0 grid-cols-[1.75rem_minmax(0,1fr)] gap-2.5 overflow-hidden rounded-xl border border-accent/20 bg-gradient-to-r from-accent/12 via-panelSoft/55 to-panelSoft/35 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                  >
                    <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-accent/25 bg-accent/12 text-accent">
                      <Target className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        <div className="space-y-2">
                          <input
                            className="h-9 w-full min-w-0 rounded-lg border border-borderSoft/80 bg-panel px-3 text-sm text-slate-100 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
                            value={editingText}
                            onChange={(event) => setEditingText(event.target.value)}
                            onKeyDown={(event) => handleEditKeyDown(event, item.id)}
                            autoFocus
                          />
                          <div className="flex shrink-0 items-center justify-end gap-1">
                            <button
                              type="button"
                              className={buttonClass("accent")}
                              disabled={isBusy}
                              onClick={() => void saveEdit(item.id)}
                              aria-label="Save focus"
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              className={buttonClass()}
                              disabled={isBusy}
                              onClick={() => {
                                setEditingId(null);
                                setEditingText("");
                              }}
                              aria-label="Cancel edit"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="min-w-0">
                          <p className="min-w-0 pr-16 text-sm font-semibold leading-6 text-slate-100 [overflow-wrap:anywhere]">
                            {item.text}
                          </p>
                          <div className="pointer-events-auto absolute right-2 top-2 flex shrink-0 items-center gap-1 opacity-100 transition duration-150 focus-within:pointer-events-auto focus-within:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 [@media(any-hover:hover)]:pointer-events-none [@media(any-hover:hover)]:opacity-0 [@media(any-hover:hover)]:group-hover:pointer-events-auto [@media(any-hover:hover)]:group-hover:opacity-100">
                            <button
                              type="button"
                              className={buttonClass()}
                              disabled={isBusy}
                              onClick={() => {
                                setEditingId(item.id);
                                setEditingText(item.text);
                              }}
                              aria-label="Edit focus"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              className={buttonClass("danger")}
                              disabled={isBusy}
                              onClick={() => void deleteFocus(item.id)}
                              aria-label="Delete focus"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <form className="rounded-xl border border-borderSoft/70 bg-panelSoft/25 p-2.5" onSubmit={submitFocus}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-300">Add focus</span>
            <span className="text-[11px] text-slate-500">{history.length} saved</span>
          </div>
          <div className="grid gap-2">
            <select
              className="h-10 min-w-0 rounded-xl border border-borderSoft/80 bg-panelSoft/40 px-3 text-sm text-slate-200 outline-none transition hover:bg-panelSoft/60 focus:border-accent/60 focus:ring-2 focus:ring-accent/15 disabled:opacity-50"
              value={selectedHistoryText}
              disabled={history.length === 0 || saving}
              onChange={(event) => {
                setSelectedHistoryText(event.target.value);
                if (event.target.value) setDraft("");
              }}
            >
              <option value="" className="bg-slate-900">
                Previous focus
              </option>
              {history.map((row) => {
                const alreadyActive = activeKeys.has(normalizeClientKey(row.text));
                return (
                  <option key={`${row.text}-${row.lastUsedAt}`} value={row.text} className="bg-slate-900">
                    {alreadyActive ? `${row.text} (active)` : row.text}
                  </option>
                );
              })}
            </select>
            <input
              className="h-10 min-w-0 rounded-xl border border-borderSoft/80 bg-panel px-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-accent/60 focus:ring-2 focus:ring-accent/15 disabled:opacity-50"
              value={draft}
              disabled={saving}
              maxLength={280}
              placeholder="New focus text"
              onChange={(event) => {
                setDraft(event.target.value);
                if (event.target.value) setSelectedHistoryText("");
              }}
              onKeyDown={handleDraftKeyDown}
            />
            <button
              type="submit"
              disabled={saving}
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-accent/40 bg-accent/15 px-3 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              Add
            </button>
          </div>
          {message && (
            <p className={`mt-2 text-xs ${message.tone === "danger" ? "text-danger" : "text-slate-400"}`}>
              {message.text}
            </p>
          )}
        </form>
      </div>
    </section>
  );
}
