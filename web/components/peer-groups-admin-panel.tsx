"use client";

import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDown, ChevronUp, Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addAdminPeerGroupMember,
  addAdminSymbolToDirectory,
  bootstrapAdminPeerGroups,
  createAdminPeerGroup,
  deleteAdminPeerGroup,
  getAdminPeerGroups,
  getAdminSymbolCatalogStatus,
  getAdminPeerTickerDetail,
  getPeerDirectory,
  removeAdminPeerGroupMember,
  searchAdminPeerTickers,
  seedAdminPeerGroup,
  setAdminSymbolCatalogSchedule,
  syncAdminSymbolCatalog,
  updateAdminPeerGroup,
  type PeerDirectoryRow,
  type PeerGroupRow,
  type PeerGroupType,
  type PeerTickerDetail,
  type SymbolCatalogStatus,
} from "@/lib/api";
import { AdminCard } from "@/components/admin/admin-card";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminStatCard } from "@/components/admin/admin-stat-card";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { EmptyState } from "@/components/admin/empty-state";
import { InlineAlert } from "@/components/admin/inline-alert";

const EMPTY_FORM = {
  name: "",
  slug: "",
  groupType: "fundamental" as PeerGroupType,
  description: "",
  priority: "0",
  isActive: true,
};

const GROUPS_PAGE_SIZE = 12;
const GROUP_INDEX_LABELS = ["All", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""), "#"];

function parseBootstrapTickers(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/[\s,]+/)
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean),
    ),
  );
}

function firstGroupIndexLabel(group: PeerGroupRow): string {
  const firstChar = (group.name.trim()[0] ?? "").toUpperCase();
  return /^[A-Z]$/.test(firstChar) ? firstChar : "#";
}

export function PeerGroupsAdminPanel() {
  const [groups, setGroups] = useState<PeerGroupRow[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [targetGroupId, setTargetGroupId] = useState<string>("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [groupQuery, setGroupQuery] = useState("");
  const [groupIndexFilter, setGroupIndexFilter] = useState("All");
  const [groupPage, setGroupPage] = useState(0);
  const [tickerQuery, setTickerQuery] = useState("");
  const [tickerResults, setTickerResults] = useState<Array<{ ticker: string; name: string | null; exchange: string | null }>>([]);
  const [selectedTicker, setSelectedTicker] = useState<string>("");
  const [selectedTickerDetail, setSelectedTickerDetail] = useState<PeerTickerDetail | null>(null);
  const [groupMembers, setGroupMembers] = useState<PeerDirectoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [catalogStatus, setCatalogStatus] = useState<SymbolCatalogStatus | null>(null);
  const [catalogSyncing, setCatalogSyncing] = useState(false);
  const [catalogScheduleSaving, setCatalogScheduleSaving] = useState(false);
  const [addingSymbol, setAddingSymbol] = useState(false);
  const [bootstrapOpen, setBootstrapOpen] = useState(false);
  const [bootstrapLimit, setBootstrapLimit] = useState("25");
  const [bootstrapProviderMode, setBootstrapProviderMode] = useState<"both" | "finnhub" | "fmp">("finnhub");
  const [bootstrapTickersText, setBootstrapTickersText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [deleteGroupOpen, setDeleteGroupOpen] = useState(false);
  const [deleteGroupBusy, setDeleteGroupBusy] = useState(false);
  const [memberToRemove, setMemberToRemove] = useState<PeerDirectoryRow | null>(null);
  const [memberRemovalBusy, setMemberRemovalBusy] = useState(false);
  const formCardRef = useRef<HTMLDivElement | null>(null);

  const flashMessage = (next: string, timeoutMs = 4000) => {
    setMessage(next);
    window.setTimeout(() => {
      setMessage((current) => current === next ? null : current);
    }, timeoutMs);
  };

  const load = async (preferredGroupId?: string | null) => {
    setLoading(true);
    try {
      const [res, nextCatalogStatus] = await Promise.all([
        getAdminPeerGroups(),
        getAdminSymbolCatalogStatus().catch(() => null),
      ]);
      const rows = res.rows ?? [];
      setCatalogStatus(nextCatalogStatus);
      setGroups(rows);
      const nextId = preferredGroupId ?? selectedGroupId ?? rows[0]?.id ?? null;
      setSelectedGroupId(nextId);
      setTargetGroupId((current) => {
        if (current && rows.some((row) => row.id === current)) return current;
        return nextId ?? rows[0]?.id ?? "";
      });
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

  const refreshCatalogStatus = async () => {
    try {
      setCatalogStatus(await getAdminSymbolCatalogStatus());
    } catch {
      // Keep the existing UI usable even if the status endpoint is temporarily unavailable.
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const next = groups.find((row) => row.id === selectedGroupId) ?? null;
    if (!next) {
      setGroupMembers([]);
      return;
    }
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

  useEffect(() => {
    if (!targetGroupId && selectedGroupId) {
      setTargetGroupId(selectedGroupId);
      return;
    }
    if (targetGroupId && groups.some((row) => row.id === targetGroupId)) return;
    setTargetGroupId(selectedGroupId ?? groups[0]?.id ?? "");
  }, [groups, selectedGroupId, targetGroupId]);

  useEffect(() => {
    setGroupPage(0);
  }, [groupQuery, groupIndexFilter]);

  const onSearchTicker = async () => {
    if (!tickerQuery.trim()) return;
    try {
      const res = await searchAdminPeerTickers(tickerQuery);
      setTickerResults((res.rows ?? []).map((row) => ({ ticker: row.ticker, name: row.name, exchange: row.exchange })));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to search tickers.");
    }
  };

  const onSelectTicker = async (ticker: string) => {
    try {
      setSelectedTicker(ticker);
      const detail = await getAdminPeerTickerDetail(ticker);
      setSelectedTickerDetail(detail);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Failed to load ${ticker}.`);
    }
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
        flashMessage("Peer group updated.");
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
        flashMessage("Peer group created.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save peer group.");
    } finally {
      setSaving(false);
    }
  };

  const onStartNewGroup = () => {
    setSelectedGroupId(null);
    setForm(EMPTY_FORM);
    setGroupMembers([]);
    formCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const filteredGroups = useMemo(() => {
    const query = groupQuery.trim().toLowerCase();
    return groups.filter((group) => {
      const matchesIndex = groupIndexFilter === "All" || firstGroupIndexLabel(group) === groupIndexFilter;
      const matchesQuery = !query
        || group.name.toLowerCase().includes(query)
        || group.slug.toLowerCase().includes(query)
        || group.groupType.toLowerCase().includes(query);
      return matchesIndex && matchesQuery;
    });
  }, [groupIndexFilter, groupQuery, groups]);

  const availableIndexLabels = useMemo(() => {
    const labels = new Set(groups.map(firstGroupIndexLabel));
    return GROUP_INDEX_LABELS.filter((label) => label === "All" || labels.has(label));
  }, [groups]);

  const totalGroupPages = Math.max(1, Math.ceil(filteredGroups.length / GROUPS_PAGE_SIZE));
  const currentGroupPage = Math.min(groupPage, totalGroupPages - 1);
  const visibleGroups = filteredGroups.slice(
    currentGroupPage * GROUPS_PAGE_SIZE,
    currentGroupPage * GROUPS_PAGE_SIZE + GROUPS_PAGE_SIZE,
  );
  const bootstrapTickers = parseBootstrapTickers(bootstrapTickersText);
  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) ?? null,
    [groups, selectedGroupId],
  );
  const selectedSymbol = selectedTickerDetail?.symbol ?? null;
  const canAddSelectedTickerToDirectory = Boolean(selectedSymbol?.ticker) && (!selectedSymbol?.persisted || !selectedSymbol?.isActive);
  const selectedSymbolActionLabel = !selectedSymbol?.persisted
    ? "Add To Directory"
    : !selectedSymbol?.isActive
      ? "Reactivate Symbol"
      : "In Directory";

  const activeGroupCount = useMemo(
    () => groups.filter((group) => group.isActive).length,
    [groups],
  );

  const handleDeleteGroup = async () => {
    if (!selectedGroupId) return;
    setDeleteGroupBusy(true);
    try {
      await deleteAdminPeerGroup(selectedGroupId);
      await load(null);
      setSelectedGroupId(null);
      setForm(EMPTY_FORM);
      setDeleteGroupOpen(false);
      flashMessage("Peer group deleted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to delete peer group.");
    } finally {
      setDeleteGroupBusy(false);
    }
  };

  const handleRemoveMember = async () => {
    if (!selectedGroupId || !memberToRemove) return;
    setMemberRemovalBusy(true);
    try {
      await removeAdminPeerGroupMember(selectedGroupId, memberToRemove.ticker);
      await load(selectedGroupId);
      if (selectedTicker === memberToRemove.ticker) {
        await onSelectTicker(memberToRemove.ticker);
      }
      flashMessage(`Removed ${memberToRemove.ticker} from the selected peer group.`);
      setMemberToRemove(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Failed to remove ${memberToRemove.ticker}.`);
    } finally {
      setMemberRemovalBusy(false);
    }
  };

  return (
    <>
      <section className="space-y-6">
        <AdminPageHeader
          eyebrow="Admin"
          title="Peer Groups"
          description="Create groups, inspect symbols, manage memberships, and run seed workflows without changing any of the existing admin endpoints."
          actions={(
            <button
              className="rounded-2xl border border-borderSoft/80 bg-panelSoft/65 px-4 py-2 text-sm text-slate-200 transition hover:bg-panelSoft"
              onClick={() => void load(selectedGroupId)}
              type="button"
            >
              Refresh Workspace
            </button>
          )}
        />

        {message ? <InlineAlert tone="info">{message}</InlineAlert> : null}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <AdminStatCard label="Groups" value={groups.length} helper="All configured peer groups." />
          <AdminStatCard label="Active Groups" value={activeGroupCount} helper="Groups currently marked active." />
          <AdminStatCard label="Visible Members" value={groupMembers.length} helper={selectedGroup ? `${selectedGroup.name} member count.` : "Select a group to inspect memberships."} />
          <AdminStatCard
            label="Directory Health"
            value={catalogStatus?.status ?? "unknown"}
            helper={catalogStatus?.lastSyncedAt ? `Last sync ${new Date(catalogStatus.lastSyncedAt).toLocaleString()}` : "Symbol catalog status may be unavailable."}
            tone={catalogStatus?.error ? "danger" : catalogStatus?.status === "ok" ? "success" : "info"}
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-[22rem,minmax(0,1fr)]">
        <div className="space-y-4">
          <AdminCard
            title="Groups"
            description={`${groups.length} total groups`}
            actions={(
              <button
                className="rounded-xl bg-accent px-3 py-2 text-sm font-medium text-slate-950 transition hover:brightness-110"
                onClick={onStartNewGroup}
                type="button"
              >
                New Group
              </button>
            )}
          >
            <div className="space-y-3">
              <label className="block text-xs text-slate-300">
                Find a group
                <div className="mt-1 flex items-center gap-2 rounded border border-borderSoft bg-panelSoft px-3 py-2">
                  <Search className="h-4 w-4 text-slate-500" />
                  <input
                    className="w-full bg-transparent text-sm outline-none"
                    value={groupQuery}
                    onChange={(event) => setGroupQuery(event.target.value)}
                    placeholder="Search name, slug, or type"
                  />
                </div>
              </label>

              <div className="flex flex-wrap gap-1.5">
                {availableIndexLabels.map((label) => (
                  <button
                    key={label}
                    className={`rounded border px-2 py-1 text-[11px] ${
                      groupIndexFilter === label
                        ? "border-accent/50 bg-accent/15 text-accent"
                        : "border-borderSoft/70 text-slate-400 hover:bg-slate-900/40"
                    }`}
                    onClick={() => setGroupIndexFilter(label)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>

              {loading ? (
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading groups...
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    {visibleGroups.map((group) => (
                      <button
                        key={group.id}
                        className={`w-full rounded border px-3 py-2 text-left ${group.id === selectedGroupId ? "border-accent/60 bg-accent/10" : "border-borderSoft/60 hover:bg-slate-900/30"}`}
                        onClick={() => setSelectedGroupId(group.id)}
                        type="button"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-accent">{group.name}</div>
                            <div className="text-[11px] text-slate-400">{group.slug}</div>
                          </div>
                          <div className="rounded bg-slate-900/60 px-2 py-0.5 text-[11px] text-slate-300">
                            {group.memberCount ?? 0}
                          </div>
                        </div>
                        <div className="mt-1 text-[11px] text-slate-400">
                          {group.groupType} | priority {group.priority} | {group.isActive ? "active" : "inactive"}
                        </div>
                      </button>
                    ))}
                    {visibleGroups.length === 0 && (
                      <EmptyState title="No groups match this filter" description="Adjust the current filter or create a new peer group." />
                    )}
                  </div>

                  <div className="flex items-center justify-between pt-2 text-[11px] text-slate-400">
                    <span>
                      {filteredGroups.length === 0
                        ? "0 groups"
                        : `Showing ${currentGroupPage * GROUPS_PAGE_SIZE + 1}-${Math.min(filteredGroups.length, (currentGroupPage + 1) * GROUPS_PAGE_SIZE)} of ${filteredGroups.length}`}
                    </span>
                    <div className="flex gap-2">
                      <button
                        className="rounded border border-borderSoft px-2 py-1 disabled:opacity-40"
                        disabled={currentGroupPage === 0}
                        onClick={() => setGroupPage((current) => Math.max(0, current - 1))}
                        type="button"
                      >
                        Prev
                      </button>
                      <button
                        className="rounded border border-borderSoft px-2 py-1 disabled:opacity-40"
                        disabled={currentGroupPage + 1 >= totalGroupPages}
                        onClick={() => setGroupPage((current) => Math.min(totalGroupPages - 1, current + 1))}
                        type="button"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </AdminCard>
        </div>

        <div className="space-y-4">
          <div ref={formCardRef} className="card p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-200">{selectedGroupId ? "Edit Group" : "Create Group"}</div>
                <div className="text-xs text-slate-400">
                  {selectedGroup ? `${selectedGroup.name} is selected for editing.` : "Create a new peer group without leaving the page."}
                </div>
              </div>
              {selectedGroupId ? (
                <button
                  className="rounded border border-borderSoft px-2.5 py-1.5 text-xs text-slate-300"
                  onClick={onStartNewGroup}
                  type="button"
                >
                  Switch To New
                </button>
              ) : null}
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="block text-xs text-slate-300">
                Name
                <input className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <label className="block text-xs text-slate-300">
                Slug
                <input className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" value={form.slug} onChange={(event) => setForm((current) => ({ ...current, slug: event.target.value }))} />
              </label>
              <label className="block text-xs text-slate-300">
                Group Type
                <select className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" value={form.groupType} onChange={(event) => setForm((current) => ({ ...current, groupType: event.target.value as PeerGroupType }))}>
                  <option value="fundamental">fundamental</option>
                  <option value="technical">technical</option>
                  <option value="custom">custom</option>
                </select>
              </label>
              <label className="block text-xs text-slate-300">
                Priority
                <input className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" value={form.priority} onChange={(event) => setForm((current) => ({ ...current, priority: event.target.value }))} />
              </label>
              <label className="block text-xs text-slate-300 md:col-span-2">
                Description
                <textarea className="mt-1 min-h-20 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} />
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" checked={form.isActive} onChange={(event) => setForm((current) => ({ ...current, isActive: event.target.checked }))} />
                Active
              </label>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button className="rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-sm text-accent" onClick={() => void onSaveGroup()} disabled={saving || !form.name.trim()} type="button">
                {saving ? "Saving..." : "Save Group"}
              </button>
              {selectedGroupId && (
                <button
                  className="rounded border border-red-500/40 px-3 py-1.5 text-sm text-red-300"
                  onClick={() => setDeleteGroupOpen(true)}
                  type="button"
                >
                  Delete
                </button>
              )}
            </div>
          </div>

          <div className="card p-3">
            <div className="mb-3 text-sm font-semibold text-slate-200">Ticker Search</div>
            <div className="mb-3 rounded border border-borderSoft/60 bg-slate-900/30 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-300">Symbol Directory</div>
                  <div className="mt-1 text-[11px] text-slate-400">
                    NasdaqTrader catalog sync with manual overrides preserved for symbols you add directly.
                  </div>
                </div>
                <button
                  className="rounded border border-borderSoft px-3 py-1.5 text-xs text-slate-200 disabled:opacity-50"
                  disabled={catalogScheduleSaving || !catalogStatus}
                  onClick={async () => {
                    if (!catalogStatus) return;
                    setCatalogScheduleSaving(true);
                    setMessage(null);
                    try {
                      const result = await setAdminSymbolCatalogSchedule(!catalogStatus.scheduledEnabled);
                      setCatalogStatus(result.status);
                      flashMessage(
                        result.enabled
                          ? "Automatic daily symbol sync enabled."
                          : "Automatic daily symbol sync disabled.",
                      );
                    } catch (error) {
                      setMessage(error instanceof Error ? error.message : "Failed to update automatic symbol sync.");
                    } finally {
                      setCatalogScheduleSaving(false);
                    }
                  }}
                  type="button"
                >
                  {catalogScheduleSaving
                    ? "Saving..."
                    : catalogStatus?.scheduledEnabled
                      ? "Disable Auto Sync"
                      : "Enable Auto Sync"}
                </button>
                <button
                  className="rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-xs text-accent disabled:opacity-50"
                  disabled={catalogSyncing}
                  onClick={async () => {
                    setCatalogSyncing(true);
                    setMessage(null);
                    try {
                      const result = await syncAdminSymbolCatalog();
                      await refreshCatalogStatus();
                      flashMessage(
                        `Symbol sync completed: ${result.inserted} added, ${result.reactivated} reactivated, ${result.deactivated} deactivated.`,
                        5000,
                      );
                    } catch (error) {
                      setMessage(error instanceof Error ? error.message : "Failed to sync the symbol directory.");
                    } finally {
                      setCatalogSyncing(false);
                    }
                  }}
                  type="button"
                >
                  {catalogSyncing ? "Syncing..." : "Run Sync Now"}
                </button>
              </div>

              {catalogStatus ? (
                <div className="mt-3 grid gap-2 text-[11px] text-slate-300 md:grid-cols-2 xl:grid-cols-5">
                  <div className="rounded border border-borderSoft/50 bg-panelSoft px-3 py-2">
                    <div className="text-slate-500">Active symbols</div>
                    <div className="mt-1 text-sm font-semibold text-slate-100">{catalogStatus.activeCount}</div>
                  </div>
                  <div className="rounded border border-borderSoft/50 bg-panelSoft px-3 py-2">
                    <div className="text-slate-500">Inactive symbols</div>
                    <div className="mt-1 text-sm font-semibold text-slate-100">{catalogStatus.inactiveCount}</div>
                  </div>
                  <div className="rounded border border-borderSoft/50 bg-panelSoft px-3 py-2">
                    <div className="text-slate-500">Manual overrides</div>
                    <div className="mt-1 text-sm font-semibold text-slate-100">{catalogStatus.manualCount}</div>
                  </div>
                  <div className="rounded border border-borderSoft/50 bg-panelSoft px-3 py-2">
                    <div className="text-slate-500">Catalog managed</div>
                    <div className="mt-1 text-sm font-semibold text-slate-100">{catalogStatus.catalogManagedCount}</div>
                  </div>
                  <div className="rounded border border-borderSoft/50 bg-panelSoft px-3 py-2">
                    <div className="text-slate-500">Scheduled sync</div>
                    <div className="mt-1 text-sm font-semibold text-slate-100">{catalogStatus.scheduledEnabled ? "Enabled" : "Disabled"}</div>
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-[11px] text-slate-500">Symbol catalog status is unavailable until the updated worker is live.</p>
              )}

              {catalogStatus?.status || catalogStatus?.lastSyncedAt || catalogStatus?.error ? (
                <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-400">
                  <span>Status: {catalogStatus.status ?? "unknown"}</span>
                  <span>Last sync: {catalogStatus.lastSyncedAt ? new Date(catalogStatus.lastSyncedAt).toLocaleString() : "never"}</span>
                  <span>Rows fetched: {catalogStatus.recordsCount ?? 0}</span>
                  {catalogStatus.error ? <span className="text-red-300">Last error: {catalogStatus.error}</span> : null}
                </div>
              ) : null}
            </div>

            <Collapsible.Root open={bootstrapOpen} onOpenChange={setBootstrapOpen} className="mb-3 overflow-hidden rounded border border-borderSoft/60 bg-slate-900/30">
              <Collapsible.Trigger className="flex w-full items-center justify-between px-3 py-3 text-left">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-300">Bootstrap Seed Batch</div>
                  <div className="mt-1 text-[11px] text-slate-400">
                    Seed from the symbol directory, or target specific tickers with comma-separated input.
                  </div>
                </div>
                <span className="rounded border border-borderSoft/70 px-2 py-1 text-[11px] text-slate-300">
                  {bootstrapOpen ? <span className="inline-flex items-center gap-1"><ChevronUp className="h-3.5 w-3.5" />Collapse</span> : <span className="inline-flex items-center gap-1"><ChevronDown className="h-3.5 w-3.5" />Expand</span>}
                </span>
              </Collapsible.Trigger>
              <Collapsible.Content className="border-t border-borderSoft/60 px-3 py-3">
                <div className="space-y-3">
                  <label className="block text-xs text-slate-300">
                    Specific tickers
                    <textarea
                      className="mt-1 min-h-20 w-full rounded border border-borderSoft bg-panelSoft px-3 py-2 text-sm"
                      value={bootstrapTickersText}
                      onChange={(event) => setBootstrapTickersText(event.target.value)}
                      placeholder="AAPL, MSFT, NVDA"
                    />
                  </label>

                  <div className="grid gap-2 md:grid-cols-[8rem,12rem,minmax(0,1fr)]">
                    <label className="block text-xs text-slate-300">
                      Batch size
                      <input
                        className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-3 py-2 text-sm disabled:opacity-50"
                        value={bootstrapLimit}
                        disabled={bootstrapTickers.length > 0}
                        onChange={(event) => setBootstrapLimit(event.target.value)}
                        placeholder="25"
                      />
                    </label>
                    <label className="block text-xs text-slate-300">
                      Provider
                      <select
                        className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-3 py-2 text-sm"
                        value={bootstrapProviderMode}
                        onChange={(event) => setBootstrapProviderMode(event.target.value as "both" | "finnhub" | "fmp")}
                      >
                        <option value="finnhub">Finnhub only</option>
                        <option value="both">Both providers</option>
                        <option value="fmp">FMP only</option>
                      </select>
                    </label>
                    <div className="flex items-end">
                      <button
                        className="w-full rounded border border-accent/40 bg-accent/15 px-3 py-2 text-sm text-accent disabled:opacity-50"
                        disabled={bootstrapping}
                        onClick={async () => {
                          setBootstrapping(true);
                          setMessage(null);
                          try {
                            const res = await bootstrapAdminPeerGroups({
                              tickers: bootstrapTickers.length > 0 ? bootstrapTickers : undefined,
                              limit: bootstrapTickers.length > 0 ? undefined : Number(bootstrapLimit || 3),
                              onlyUnseeded: true,
                              providerMode: bootstrapProviderMode,
                              enrichPeers: false,
                            });
                            await load(selectedGroupId);
                            const okCount = (res.rows ?? []).filter((row) => row.ok).length;
                            const errorCount = (res.rows ?? []).filter((row) => !row.ok).length;
                            flashMessage(
                              bootstrapTickers.length > 0
                                ? `Bootstrapped ${okCount} requested ticker${okCount === 1 ? "" : "s"}${errorCount ? `, ${errorCount} failed` : ""}.`
                                : `Bootstrap seeded ${okCount} ticker${okCount === 1 ? "" : "s"}${errorCount ? `, ${errorCount} failed` : ""}.`,
                            );
                          } catch (error) {
                            setMessage(error instanceof Error ? error.message : "Failed to bootstrap peer groups.");
                          } finally {
                            setBootstrapping(false);
                          }
                        }}
                        type="button"
                      >
                        {bootstrapping ? "Bootstrapping..." : bootstrapTickers.length > 0 ? "Bootstrap Tickers" : "Bootstrap Batch"}
                      </button>
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-400">
                    {bootstrapTickers.length > 0
                      ? `Targeting ${bootstrapTickers.length} ticker${bootstrapTickers.length === 1 ? "" : "s"} directly.`
                      : "Leave specific tickers blank to seed the next unseeded candidates from the symbols directory."}
                    {" "}Finnhub-only remains the fastest option.
                  </p>
                </div>
              </Collapsible.Content>
            </Collapsible.Root>
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
              <button className="rounded border border-accent/40 bg-accent/15 px-3 py-2 text-sm text-accent" onClick={() => void onSearchTicker()} type="button">
                Search
              </button>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {tickerResults.map((row) => (
                <button
                  key={row.ticker}
                  className={`rounded border px-3 py-2 text-left ${selectedTicker === row.ticker ? "border-accent/60 bg-accent/10" : "border-borderSoft/60 hover:bg-slate-900/30"}`}
                  onClick={() => void onSelectTicker(row.ticker)}
                  type="button"
                >
                  <div className="text-sm font-semibold text-accent">{row.ticker}</div>
                  <div className="text-[11px] text-slate-400">{row.name ?? "-"} {row.exchange ? `| ${row.exchange}` : ""}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr),minmax(0,1fr)]">
            <div className="card p-3">
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-200">Selected Ticker</h4>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="rounded border border-borderSoft px-3 py-1.5 text-xs text-slate-200 disabled:opacity-50"
                    disabled={!canAddSelectedTickerToDirectory || addingSymbol}
                    onClick={async () => {
                      if (!selectedSymbol?.ticker || !canAddSelectedTickerToDirectory) return;
                      setAddingSymbol(true);
                      setMessage(null);
                      try {
                        const result = await addAdminSymbolToDirectory(selectedSymbol.ticker);
                        await load(selectedGroupId);
                        if (result.detail) {
                          setSelectedTickerDetail(result.detail);
                          setSelectedTicker(result.detail.symbol.ticker);
                        } else {
                          await onSelectTicker(selectedSymbol.ticker);
                        }
                        await refreshCatalogStatus();
                        flashMessage(
                          result.created
                            ? `${result.ticker} was added to the symbol directory.`
                            : result.reactivated
                              ? `${result.ticker} was reactivated in the symbol directory.`
                              : `${result.ticker} is already available in the symbol directory.`,
                        );
                      } catch (error) {
                        setMessage(error instanceof Error ? error.message : `Failed to add ${selectedSymbol.ticker} to the symbol directory.`);
                      } finally {
                        setAddingSymbol(false);
                      }
                    }}
                    type="button"
                  >
                    {addingSymbol ? "Saving..." : selectedSymbolActionLabel}
                  </button>
                  <button
                    className="rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-xs text-accent"
                    disabled={!selectedTicker}
                    onClick={async () => {
                      if (!selectedTicker) return;
                      try {
                        await seedAdminPeerGroup(selectedTicker);
                        await load(selectedGroupId);
                        await onSelectTicker(selectedTicker);
                        flashMessage(`Seeded peers for ${selectedTicker}.`);
                      } catch (error) {
                        setMessage(error instanceof Error ? error.message : `Failed to seed peers for ${selectedTicker}.`);
                      }
                    }}
                    type="button"
                  >
                    Seed Peers
                  </button>
                </div>
              </div>
              {selectedTickerDetail ? (
                <div className="space-y-3 text-sm">
                  <div>
                    <div className="font-semibold text-accent">{selectedTickerDetail.symbol.ticker}</div>
                    <div className="text-slate-300">{selectedTickerDetail.symbol.name ?? "-"}</div>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px] text-slate-300">
                    <span className="rounded border border-borderSoft/60 bg-slate-900/40 px-2 py-1">
                      {selectedTickerDetail.symbol.persisted ? "In directory" : "Resolved only"}
                    </span>
                    {selectedTickerDetail.symbol.persisted ? (
                      <span className={`rounded border px-2 py-1 ${selectedTickerDetail.symbol.isActive ? "border-emerald-500/30 text-emerald-300" : "border-amber-500/30 text-amber-300"}`}>
                        {selectedTickerDetail.symbol.isActive ? "Active" : "Inactive"}
                      </span>
                    ) : null}
                    {selectedTickerDetail.symbol.listingSource ? (
                      <span className="rounded border border-borderSoft/60 bg-slate-900/40 px-2 py-1">
                        Source: {selectedTickerDetail.symbol.listingSource}
                      </span>
                    ) : null}
                    {selectedTickerDetail.symbol.catalogManaged ? (
                      <span className="rounded border border-borderSoft/60 bg-slate-900/40 px-2 py-1">
                        Catalog managed
                      </span>
                    ) : null}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    {selectedTickerDetail.symbol.persisted
                      ? selectedTickerDetail.symbol.isActive
                        ? "This symbol is currently available in the peer-group directory."
                        : "This symbol exists in the directory but is inactive. Reactivate it to include it in active candidate flows."
                      : "This symbol resolved successfully but is not yet stored in the directory."}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selectedTickerDetail.groups.map((group) => (
                      <span key={group.id} className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-300">{group.name}</span>
                    ))}
                    {selectedTickerDetail.groups.length === 0 && <span className="text-xs text-slate-500">No peer-group memberships yet.</span>}
                  </div>
                  <div className="rounded border border-borderSoft/60 bg-slate-900/30 p-3">
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Assign To Peer Group</div>
                    <div className="grid gap-2 md:grid-cols-[minmax(0,1fr),auto]">
                      <select
                        className="rounded border border-borderSoft bg-panelSoft px-3 py-2 text-xs"
                        value={targetGroupId}
                        onChange={(event) => setTargetGroupId(event.target.value)}
                      >
                        <option value="" disabled>Select target group</option>
                        {groups.map((group) => (
                          <option key={group.id} value={group.id}>
                            {group.name} ({group.groupType})
                          </option>
                        ))}
                      </select>
                      <button
                        className="rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-xs text-accent"
                        disabled={!targetGroupId || !selectedTickerDetail.symbol.ticker || selectedTickerDetail.groups.some((group) => group.id === targetGroupId)}
                        onClick={async () => {
                          if (!targetGroupId || !selectedTickerDetail.symbol.ticker) return;
                          try {
                            const targetGroup = groups.find((group) => group.id === targetGroupId) ?? null;
                            await addAdminPeerGroupMember(targetGroupId, { ticker: selectedTickerDetail.symbol.ticker, source: "manual", confidence: 1 });
                            await load(targetGroupId);
                            await onSelectTicker(selectedTickerDetail.symbol.ticker);
                            flashMessage(`Added ${selectedTickerDetail.symbol.ticker} to ${targetGroup?.name ?? "the selected peer group"}.`);
                          } catch (error) {
                            setMessage(error instanceof Error ? error.message : "Failed to add ticker to peer group.");
                          }
                        }}
                        type="button"
                      >
                        {selectedTickerDetail.groups.some((group) => group.id === targetGroupId) ? "Already In Group" : "Add Ticker To Group"}
                      </button>
                    </div>
                    <p className="mt-2 text-[11px] text-slate-400">
                      Choose any peer group here to manually assign the selected ticker.
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-400">Search and select a ticker to inspect or seed peer memberships.</p>
              )}
            </div>

            <div className="card p-3">
              <div className="mb-2 text-sm font-semibold text-slate-200">Selected Group Members</div>
              {selectedGroup ? (
                <p className="mb-3 text-xs text-slate-400">{selectedGroup.name} currently has {groupMembers.length} visible member{groupMembers.length === 1 ? "" : "s"}.</p>
              ) : (
                <p className="mb-3 text-xs text-slate-400">Save or select a group to manage its memberships.</p>
              )}
              <div className="space-y-2">
                {groupMembers.map((row) => (
                  <div key={`${selectedGroupId}-${row.ticker}`} className="flex items-center justify-between rounded border border-borderSoft/60 px-3 py-2 text-sm">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="font-semibold text-accent">{row.ticker}</div>
                        {row.symbolIsActive === false ? (
                          <span className="rounded border border-amber-500/30 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-amber-300">
                            inactive
                          </span>
                        ) : null}
                      </div>
                      <div className="text-[11px] text-slate-400">{row.name ?? "-"}</div>
                    </div>
                    {selectedGroupId && (
                      <button
                        className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-300"
                        onClick={() => setMemberToRemove(row)}
                        type="button"
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

      <ConfirmDialog
        open={deleteGroupOpen}
        title="Delete peer group?"
        description={selectedGroup ? `Delete ${selectedGroup.name} and all of its memberships?` : "Delete the selected peer group?"}
        confirmLabel="Delete Group"
        tone="danger"
        busy={deleteGroupBusy}
        onCancel={() => setDeleteGroupOpen(false)}
        onConfirm={handleDeleteGroup}
      />

      <ConfirmDialog
        open={Boolean(memberToRemove)}
        title="Remove member?"
        description={memberToRemove ? `Remove ${memberToRemove.ticker} from ${selectedGroup?.name ?? "the selected peer group"}?` : ""}
        confirmLabel="Remove Member"
        tone="danger"
        busy={memberRemovalBusy}
        onCancel={() => setMemberToRemove(null)}
        onConfirm={handleRemoveMember}
      />
    </>
  );
}
