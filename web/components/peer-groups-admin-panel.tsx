"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  addAdminPeerGroupMember,
  bootstrapAdminPeerGroups,
  createAdminPeerGroup,
  deleteAdminPeerGroup,
  getAdminPeerGroups,
  getAdminPeerTickerDetail,
  getPeerDirectory,
  removeAdminPeerGroupMember,
  searchAdminPeerTickers,
  seedAdminPeerGroup,
  updateAdminPeerGroup,
  type PeerDirectoryRow,
  type PeerGroupRow,
  type PeerGroupType,
  type PeerTickerDetail,
} from "@/lib/api";

const EMPTY_FORM = {
  name: "",
  slug: "",
  groupType: "fundamental" as PeerGroupType,
  description: "",
  priority: "0",
  isActive: true,
};

export function PeerGroupsAdminPanel() {
  const [groups, setGroups] = useState<PeerGroupRow[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [tickerQuery, setTickerQuery] = useState("");
  const [tickerResults, setTickerResults] = useState<Array<{ ticker: string; name: string | null; exchange: string | null }>>([]);
  const [selectedTicker, setSelectedTicker] = useState<string>("");
  const [selectedTickerDetail, setSelectedTickerDetail] = useState<PeerTickerDetail | null>(null);
  const [groupMembers, setGroupMembers] = useState<PeerDirectoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [bootstrapLimit, setBootstrapLimit] = useState("3");
  const [message, setMessage] = useState<string | null>(null);

  const load = async (preferredGroupId?: string | null) => {
    setLoading(true);
    try {
      const res = await getAdminPeerGroups();
      const rows = res.rows ?? [];
      setGroups(rows);
      const nextId = preferredGroupId ?? selectedGroupId ?? rows[0]?.id ?? null;
      setSelectedGroupId(nextId);
      const selected = rows.find((row) => row.id === nextId) ?? null;
      setForm(selected ? {
        name: selected.name,
        slug: selected.slug,
        groupType: selected.groupType,
        description: selected.description ?? "",
        priority: String(selected.priority ?? 0),
        isActive: selected.isActive,
      } : EMPTY_FORM);
      if (nextId) {
        const members = await getPeerDirectory({ groupId: nextId, limit: 100, offset: 0 });
        setGroupMembers(members.rows ?? []);
      } else {
        setGroupMembers([]);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load peer-group admin data.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const next = groups.find((row) => row.id === selectedGroupId) ?? null;
    if (!next) return;
    setForm({
      name: next.name,
      slug: next.slug,
      groupType: next.groupType,
      description: next.description ?? "",
      priority: String(next.priority ?? 0),
      isActive: next.isActive,
    });
    void getPeerDirectory({ groupId: next.id, limit: 100, offset: 0 }).then((res) => setGroupMembers(res.rows ?? []));
  }, [selectedGroupId, groups]);

  const onSearchTicker = async () => {
    if (!tickerQuery.trim()) return;
    const res = await searchAdminPeerTickers(tickerQuery);
    setTickerResults((res.rows ?? []).map((row) => ({ ticker: row.ticker, name: row.name, exchange: row.exchange })));
  };

  const onSelectTicker = async (ticker: string) => {
    setSelectedTicker(ticker);
    const detail = await getAdminPeerTickerDetail(ticker);
    setSelectedTickerDetail(detail);
  };

  const onSaveGroup = async () => {
    setSaving(true);
    setMessage(null);
    try {
      if (selectedGroupId) {
        await updateAdminPeerGroup(selectedGroupId, {
          name: form.name,
          slug: form.slug || null,
          groupType: form.groupType,
          description: form.description || null,
          priority: Number(form.priority || 0),
          isActive: form.isActive,
        });
        await load(selectedGroupId);
        setMessage("Peer group updated.");
      } else {
        const created = await createAdminPeerGroup({
          name: form.name,
          slug: form.slug || null,
          groupType: form.groupType,
          description: form.description || null,
          priority: Number(form.priority || 0),
          isActive: form.isActive,
        });
        await load(created.id);
        setMessage("Peer group created.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save peer group.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">Peer Groups</h3>
        <p className="text-sm text-slate-400">Create groups, assign tickers, and run manual bootstrap imports from seed providers.</p>
      </div>

      {message && <div className="card border border-borderSoft/70 p-3 text-sm text-slate-300">{message}</div>}

      <div className="grid gap-4 xl:grid-cols-[20rem,minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="card p-3">
            <div className="mb-3 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-slate-200">Groups</h4>
              <button
                className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-300"
                onClick={() => {
                  setSelectedGroupId(null);
                  setForm(EMPTY_FORM);
                }}
              >
                New
              </button>
            </div>
            {loading ? (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading groups...
              </div>
            ) : (
              <div className="space-y-2">
                {groups.map((group) => (
                  <button
                    key={group.id}
                    className={`w-full rounded border px-3 py-2 text-left ${group.id === selectedGroupId ? "border-accent/60 bg-accent/10" : "border-borderSoft/60 hover:bg-slate-900/30"}`}
                    onClick={() => setSelectedGroupId(group.id)}
                  >
                    <div className="text-sm font-semibold text-accent">{group.name}</div>
                    <div className="text-[11px] text-slate-400">{group.groupType} • {group.memberCount ?? 0} members</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="card p-3 text-xs text-slate-300">
            <div className="mb-2 font-semibold text-slate-200">{selectedGroupId ? "Edit Group" : "Create Group"}</div>
            <div className="space-y-3">
              <label className="block">
                Name
                <input className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <label className="block">
                Slug
                <input className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" value={form.slug} onChange={(event) => setForm((current) => ({ ...current, slug: event.target.value }))} />
              </label>
              <label className="block">
                Group Type
                <select className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" value={form.groupType} onChange={(event) => setForm((current) => ({ ...current, groupType: event.target.value as PeerGroupType }))}>
                  <option value="fundamental">fundamental</option>
                  <option value="technical">technical</option>
                  <option value="custom">custom</option>
                </select>
              </label>
              <label className="block">
                Description
                <textarea className="mt-1 min-h-20 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} />
              </label>
              <label className="block">
                Priority
                <input className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" value={form.priority} onChange={(event) => setForm((current) => ({ ...current, priority: event.target.value }))} />
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.isActive} onChange={(event) => setForm((current) => ({ ...current, isActive: event.target.checked }))} />
                Active
              </label>
              <div className="flex gap-2">
                <button className="rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-sm text-accent" onClick={() => void onSaveGroup()} disabled={saving || !form.name.trim()}>
                  {saving ? "Saving..." : "Save Group"}
                </button>
                {selectedGroupId && (
                  <button
                    className="rounded border border-red-500/40 px-3 py-1.5 text-sm text-red-300"
                    onClick={async () => {
                      await deleteAdminPeerGroup(selectedGroupId);
                      await load(null);
                      setSelectedGroupId(null);
                      setForm(EMPTY_FORM);
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="card p-3">
            <div className="mb-3 text-sm font-semibold text-slate-200">Ticker Search</div>
            <div className="mb-3 rounded border border-borderSoft/60 bg-slate-900/30 p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Bootstrap Seed Batch</div>
              <div className="flex gap-2">
                <input
                  className="w-24 rounded border border-borderSoft bg-panelSoft px-3 py-2 text-sm"
                  value={bootstrapLimit}
                  onChange={(event) => setBootstrapLimit(event.target.value)}
                  placeholder="3"
                />
                <button
                  className="rounded border border-accent/40 bg-accent/15 px-3 py-2 text-sm text-accent disabled:opacity-50"
                  disabled={bootstrapping}
                  onClick={async () => {
                    setBootstrapping(true);
                    setMessage(null);
                    try {
                      const res = await bootstrapAdminPeerGroups({
                        limit: Number(bootstrapLimit || 3),
                        onlyUnseeded: true,
                      });
                      await load(selectedGroupId);
                      const okCount = (res.rows ?? []).filter((row) => row.ok).length;
                      const errorCount = (res.rows ?? []).filter((row) => !row.ok).length;
                      setMessage(`Bootstrap seeded ${okCount} ticker${okCount === 1 ? "" : "s"}${errorCount ? `, ${errorCount} failed` : ""}.`);
                    } catch (error) {
                      setMessage(error instanceof Error ? error.message : "Failed to bootstrap peer groups.");
                    } finally {
                      setBootstrapping(false);
                    }
                  }}
                >
                  {bootstrapping ? "Bootstrapping..." : "Bootstrap Batch"}
                </button>
              </div>
              <p className="mt-2 text-[11px] text-slate-400">Seeds the next unassigned equity tickers from Finnhub/FMP into self-managed peer groups.</p>
            </div>
            <div className="flex gap-2">
              <input
                className="w-full rounded border border-borderSoft bg-panelSoft px-3 py-2 text-sm"
                value={tickerQuery}
                onChange={(event) => setTickerQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void onSearchTicker();
                }}
                placeholder="AAPL"
              />
              <button className="rounded border border-accent/40 bg-accent/15 px-3 py-2 text-sm text-accent" onClick={() => void onSearchTicker()}>
                Search
              </button>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {tickerResults.map((row) => (
                <button
                  key={row.ticker}
                  className={`rounded border px-3 py-2 text-left ${selectedTicker === row.ticker ? "border-accent/60 bg-accent/10" : "border-borderSoft/60 hover:bg-slate-900/30"}`}
                  onClick={() => void onSelectTicker(row.ticker)}
                >
                  <div className="text-sm font-semibold text-accent">{row.ticker}</div>
                  <div className="text-[11px] text-slate-400">{row.name ?? "-"} {row.exchange ? `• ${row.exchange}` : ""}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr),minmax(0,1fr)]">
            <div className="card p-3">
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-200">Selected Ticker</h4>
                <button
                  className="rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-xs text-accent"
                  disabled={!selectedTicker}
                  onClick={async () => {
                    if (!selectedTicker) return;
                    await seedAdminPeerGroup(selectedTicker);
                    await load(selectedGroupId);
                    await onSelectTicker(selectedTicker);
                    setMessage(`Seeded peers for ${selectedTicker}.`);
                  }}
                >
                  Seed Peers
                </button>
              </div>
              {selectedTickerDetail ? (
                <div className="space-y-3 text-sm">
                  <div>
                    <div className="font-semibold text-accent">{selectedTickerDetail.symbol.ticker}</div>
                    <div className="text-slate-300">{selectedTickerDetail.symbol.name ?? "-"}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selectedTickerDetail.groups.map((group) => (
                      <span key={group.id} className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-300">{group.name}</span>
                    ))}
                    {selectedTickerDetail.groups.length === 0 && <span className="text-xs text-slate-500">No peer-group memberships yet.</span>}
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-xs text-accent"
                      disabled={!selectedGroupId || !selectedTickerDetail.symbol.ticker}
                      onClick={async () => {
                        if (!selectedGroupId || !selectedTickerDetail.symbol.ticker) return;
                        await addAdminPeerGroupMember(selectedGroupId, { ticker: selectedTickerDetail.symbol.ticker, source: "manual", confidence: 1 });
                        await load(selectedGroupId);
                        await onSelectTicker(selectedTickerDetail.symbol.ticker);
                        setMessage(`Added ${selectedTickerDetail.symbol.ticker} to the selected peer group.`);
                      }}
                    >
                      Add To Selected Group
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-400">Search and select a ticker to inspect or seed peer memberships.</p>
              )}
            </div>

            <div className="card p-3">
              <div className="mb-2 text-sm font-semibold text-slate-200">Selected Group Members</div>
              <div className="space-y-2">
                {groupMembers.map((row) => (
                  <div key={`${selectedGroupId}-${row.ticker}`} className="flex items-center justify-between rounded border border-borderSoft/60 px-3 py-2 text-sm">
                    <div>
                      <div className="font-semibold text-accent">{row.ticker}</div>
                      <div className="text-[11px] text-slate-400">{row.name ?? "-"}</div>
                    </div>
                    {selectedGroupId && (
                      <button
                        className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-300"
                        onClick={async () => {
                          await removeAdminPeerGroupMember(selectedGroupId, row.ticker);
                          await load(selectedGroupId);
                          if (selectedTicker === row.ticker) await onSelectTicker(row.ticker);
                          setMessage(`Removed ${row.ticker} from the selected peer group.`);
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
                {groupMembers.length === 0 && <p className="text-sm text-slate-400">No members in the selected group yet.</p>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
