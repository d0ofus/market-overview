"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/api";
import type { SnapshotResponse } from "@/types/dashboard";

const rankingOptions = ["1D", "5D", "1W", "YTD", "52W"] as const;
const allColumns = ["ticker", "name", "price", "1D", "1W", "5D", "YTD", "pctFrom52WHigh", "sparkline"];

export function AdminBuilder() {
  const [data, setData] = useState<SnapshotResponse["config"] | null>(null);
  const [tickerInput, setTickerInput] = useState<Record<string, string>>({});
  const [newSectionTitle, setNewSectionTitle] = useState("");
  const [newGroupTitle, setNewGroupTitle] = useState<Record<string, string>>({});

  const load = async () => {
    const config = await adminFetch<SnapshotResponse["config"]>("/api/admin/config");
    setData(config);
  };
  useEffect(() => {
    void load();
  }, []);

  const patchGroup = async (groupId: string, patch: any) => {
    await adminFetch("/api/admin/group/" + groupId, { method: "PATCH", body: JSON.stringify(patch) });
    await load();
  };

  const addTicker = async (groupId: string) => {
    const list = (tickerInput[groupId] ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    for (const t of list) {
      await adminFetch("/api/admin/group/" + groupId + "/items", {
        method: "POST",
        body: JSON.stringify({ ticker: t, tags: [] }),
      });
    }
    setTickerInput((s) => ({ ...s, [groupId]: "" }));
    await load();
  };

  const removeItem = async (itemId: string) => {
    await adminFetch("/api/admin/item/" + itemId, { method: "DELETE" });
    await load();
  };
  const addSection = async () => {
    if (!newSectionTitle.trim()) return;
    await adminFetch("/api/admin/section", { method: "POST", body: JSON.stringify({ title: newSectionTitle.trim() }) });
    setNewSectionTitle("");
    await load();
  };
  const addGroup = async (sectionId: string) => {
    const title = (newGroupTitle[sectionId] ?? "").trim();
    if (!title) return;
    await adminFetch("/api/admin/section/" + sectionId + "/group", { method: "POST", body: JSON.stringify({ title }) });
    setNewGroupTitle((s) => ({ ...s, [sectionId]: "" }));
    await load();
  };

  const move = async (type: "group" | "item", ids: string[], index: number, dir: -1 | 1) => {
    const to = index + dir;
    if (to < 0 || to >= ids.length) return;
    const next = [...ids];
    const [el] = next.splice(index, 1);
    next.splice(to, 0, el);
    await adminFetch("/api/admin/reorder", { method: "POST", body: JSON.stringify({ type, orderedIds: next }) });
    await load();
  };

  if (!data) return <div className="card p-4">Loading admin config...</div>;

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap gap-2 p-3">
        <input className="flex-1 rounded border border-borderSoft bg-panelSoft px-2 py-1" value={newSectionTitle} onChange={(e) => setNewSectionTitle(e.target.value)} placeholder="New section title" />
        <button className="rounded bg-accent/20 px-3 py-1 text-sm" onClick={addSection}>
          Add section
        </button>
      </div>
      {data.sections.map((section) => (
        <div key={section.id} className="card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-lg font-semibold">{section.title}</h3>
            <button className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-300" onClick={async () => {
              await adminFetch("/api/admin/section/" + section.id, { method: "DELETE" });
              await load();
            }}>
              Delete section
            </button>
          </div>
          <div className="mb-3 flex gap-2">
            <input
              className="flex-1 rounded border border-borderSoft bg-panelSoft px-2 py-1"
              value={newGroupTitle[section.id] ?? ""}
              onChange={(e) => setNewGroupTitle((s) => ({ ...s, [section.id]: e.target.value }))}
              placeholder="New group title"
            />
            <button className="rounded bg-accent/20 px-3 py-1 text-sm" onClick={() => addGroup(section.id)}>
              Add group
            </button>
          </div>
          <div className="space-y-3">
            {section.groups.map((group, gi) => (
              <div key={group.id} className="rounded border border-borderSoft p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <input
                    className="rounded border border-borderSoft bg-panelSoft px-2 py-1"
                    value={group.title}
                    onChange={(e) => {
                      const next = structuredClone(data);
                      const target = next.sections.find((s) => s.id === section.id)?.groups.find((g) => g.id === group.id);
                      if (target) target.title = e.target.value;
                      setData(next);
                    }}
                  />
                  <select
                    className="rounded border border-borderSoft bg-panelSoft px-2 py-1"
                    value={group.rankingWindowDefault}
                    onChange={(e) => patchGroup(group.id, { ...group, rankingWindowDefault: e.target.value })}
                  >
                    {rankingOptions.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <button className="rounded border border-borderSoft px-2 py-1 text-xs" onClick={() => move("group", section.groups.map((g) => g.id), gi, -1)}>
                    Up
                  </button>
                  <button className="rounded border border-borderSoft px-2 py-1 text-xs" onClick={() => move("group", section.groups.map((g) => g.id), gi, 1)}>
                    Down
                  </button>
                  <button className="rounded bg-accent/20 px-2 py-1 text-xs" onClick={() => patchGroup(group.id, group)}>
                    Save group
                  </button>
                  <button className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-300" onClick={async () => {
                    await adminFetch("/api/admin/group/" + group.id, { method: "DELETE" });
                    await load();
                  }}>
                    Delete group
                  </button>
                </div>
                <div className="mb-2 flex flex-wrap gap-2 text-xs">
                  {allColumns.map((col) => (
                    <label key={col} className="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={group.columns.includes(col)}
                        onChange={(e) => {
                          const nextCols = e.target.checked
                            ? [...group.columns, col]
                            : group.columns.filter((c) => c !== col);
                          patchGroup(group.id, { ...group, columns: nextCols });
                        }}
                      />
                      {col}
                    </label>
                  ))}
                </div>
                <div className="mb-2 flex gap-2">
                  <input
                    className="flex-1 rounded border border-borderSoft bg-panelSoft px-2 py-1"
                    value={tickerInput[group.id] ?? ""}
                    onChange={(e) => setTickerInput((s) => ({ ...s, [group.id]: e.target.value }))}
                    placeholder="Add tickers: XBI, TLT, EFA"
                  />
                  <button className="rounded bg-accent/20 px-3 py-1 text-sm" onClick={() => addTicker(group.id)}>
                    Add
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {group.items.map((item, ii) => (
                    <span key={item.id} className="rounded bg-panelSoft px-2 py-1 text-xs">
                      {item.ticker}
                      <button className="ml-2 text-red-400" onClick={() => removeItem(item.id)}>
                        x
                      </button>
                      <button
                        className="ml-2 text-slate-400"
                        onClick={() => move("item", group.items.map((i) => i.id), ii, -1)}
                      >
                        ^
                      </button>
                      <button
                        className="ml-1 text-slate-400"
                        onClick={() => move("item", group.items.map((i) => i.id), ii, 1)}
                      >
                        v
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
