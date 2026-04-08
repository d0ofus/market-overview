"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Save, Trash2 } from "lucide-react";
import { AdminCard } from "./admin-card";
import { ConfirmDialog } from "./confirm-dialog";
import { EmptyState } from "./empty-state";
import { InlineAlert } from "./inline-alert";
import { allColumns, isOverviewAdminSection, rankingOptions } from "./overview-admin-shared";
import { useOverviewAdminConfig } from "./use-overview-admin-config";

type Props = {
  state: ReturnType<typeof useOverviewAdminConfig>;
};

type DeleteIntent =
  | { type: "section"; id: string; title: string }
  | { type: "group"; id: string; title: string }
  | { type: "item"; id: string; title: string };

export function OverviewLayoutGroupsPanel({ state }: Props) {
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [deleteIntent, setDeleteIntent] = useState<DeleteIntent | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const sections = state.data?.sections ?? [];

  useEffect(() => {
    if (!sections.length) {
      setSelectedSectionId(null);
      setSelectedGroupId(null);
      return;
    }
    if (!selectedSectionId || !sections.some((section) => section.id === selectedSectionId)) {
      setSelectedSectionId(sections[0].id);
    }
  }, [sections, selectedSectionId]);

  const selectedSection = useMemo(
    () => sections.find((section) => section.id === selectedSectionId) ?? null,
    [sections, selectedSectionId],
  );

  useEffect(() => {
    const groups = selectedSection?.groups ?? [];
    if (!groups.length) {
      setSelectedGroupId(null);
      return;
    }
    if (!selectedGroupId || !groups.some((group) => group.id === selectedGroupId)) {
      setSelectedGroupId(groups[0].id);
    }
  }, [selectedGroupId, selectedSection]);

  const selectedGroup = useMemo(
    () => selectedSection?.groups.find((group) => group.id === selectedGroupId) ?? null,
    [selectedGroupId, selectedSection],
  );

  const selectedGroupIndex = selectedSection?.groups.findIndex((group) => group.id === selectedGroupId) ?? -1;

  const handleDelete = async () => {
    if (!deleteIntent) return;
    setDeleteBusy(true);
    try {
      if (deleteIntent.type === "section") {
        await state.deleteSection(deleteIntent.id);
      } else if (deleteIntent.type === "group") {
        await state.deleteGroup(deleteIntent.id);
      } else {
        await state.removeItem(deleteIntent.id);
      }
      setDeleteIntent(null);
    } finally {
      setDeleteBusy(false);
    }
  };

  if (state.isLoading) {
    return (
      <div className="grid gap-6 xl:grid-cols-[18rem,19rem,minmax(0,1fr)]">
        <div className="admin-surface h-[26rem] animate-pulse bg-panelSoft/60" />
        <div className="admin-surface h-[26rem] animate-pulse bg-panelSoft/60" />
        <div className="admin-surface h-[26rem] animate-pulse bg-panelSoft/60" />
      </div>
    );
  }

  if (state.loadError) {
    return <InlineAlert tone="danger">{state.loadError}</InlineAlert>;
  }

  if (!state.data) {
    return (
      <EmptyState
        title="Overview config unavailable"
        description="The worker did not return any dashboard configuration to edit."
        action={<button className="rounded-2xl border border-borderSoft/80 bg-panelSoft/65 px-4 py-2 text-sm text-slate-200 transition hover:bg-panelSoft" onClick={() => void state.load()} type="button">Retry</button>}
      />
    );
  }

  return (
    <>
      {state.message ? <InlineAlert tone={state.message.tone === "danger" ? "danger" : state.message.tone}>{state.message.text}</InlineAlert> : null}
      <div className="grid gap-6 xl:grid-cols-[18rem,19rem,minmax(0,1fr)]">
        <AdminCard
          title="Sections"
          description="Pick the part of the overview config you want to work on."
          actions={
            <button
              className="rounded-xl bg-accent px-3 py-2 text-sm font-medium text-slate-950 transition hover:brightness-110"
              onClick={() => void state.addSection()}
              type="button"
            >
              Add Section
            </button>
          }
        >
          <div className="space-y-3">
            <input
              className="h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
              value={state.newSectionTitle}
              onChange={(event) => state.setNewSectionTitle(event.target.value)}
              placeholder="New section title"
            />
            <div className="space-y-2">
              {sections.map((section) => (
                <button
                  key={section.id}
                  className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                    section.id === selectedSectionId
                      ? "border-accent/40 bg-accent/10"
                      : "border-borderSoft/70 bg-panelSoft/45 hover:border-accent/20 hover:bg-panelSoft/70"
                  }`}
                  onClick={() => setSelectedSectionId(section.id)}
                  type="button"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-text">{section.title}</div>
                      <div className="mt-1 text-[11px] text-slate-400">{section.description ?? "No description"}</div>
                    </div>
                    <span className="rounded-full border border-borderSoft/70 bg-panel px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                      {isOverviewAdminSection(section.title) ? "Overview" : "Other"}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </AdminCard>

        <AdminCard
          title={selectedSection ? `Groups In ${selectedSection.title}` : "Groups"}
          description={selectedSection ? "Choose a group to edit, then use the editor for group settings and members." : "Select a section first."}
          actions={selectedSection ? (
            <button
              className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100 transition hover:bg-rose-500/20"
              onClick={() => setDeleteIntent({ type: "section", id: selectedSection.id, title: selectedSection.title })}
              type="button"
            >
              Delete Section
            </button>
          ) : null}
        >
          {selectedSection ? (
            <div className="space-y-4">
              <div className="flex gap-2">
                <input
                  className="h-11 flex-1 rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                  value={state.newGroupTitle[selectedSection.id] ?? ""}
                  onChange={(event) => state.setNewGroupTitle((current) => ({ ...current, [selectedSection.id]: event.target.value }))}
                  placeholder="New group title"
                />
                <button
                  className="rounded-2xl bg-accent px-3 py-2 text-sm font-medium text-slate-950 transition hover:brightness-110"
                  onClick={() => void state.addGroup(selectedSection.id)}
                  type="button"
                >
                  Add
                </button>
              </div>
              {selectedSection.groups.length === 0 ? (
                <EmptyState title="No groups yet" description="Create the first group in this section to start adding tickers and columns." />
              ) : (
                <div className="space-y-2">
                  {selectedSection.groups.map((group) => (
                    <button
                      key={group.id}
                      className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                        group.id === selectedGroupId
                          ? "border-accent/40 bg-accent/10"
                          : "border-borderSoft/70 bg-panelSoft/45 hover:border-accent/20 hover:bg-panelSoft/70"
                      }`}
                      onClick={() => setSelectedGroupId(group.id)}
                      type="button"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-text">{group.title}</div>
                          <div className="mt-1 text-[11px] text-slate-400">{group.columns.length} columns · {group.items.length} tickers</div>
                        </div>
                        <span className="rounded-full border border-borderSoft/70 bg-panel px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                          {group.rankingWindowDefault}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <EmptyState title="Select a section" description="Choose a section from the left to manage its groups." />
          )}
        </AdminCard>

        <AdminCard
          title={selectedGroup ? selectedGroup.title : "Group Editor"}
          description={selectedGroup ? "Edit the selected group, manage columns, and maintain member tickers." : "Select a group to begin editing."}
          actions={selectedGroup && selectedSection ? (
            <>
              <button
                className="rounded-xl border border-borderSoft/80 bg-panelSoft/65 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft disabled:opacity-50"
                disabled={selectedGroupIndex <= 0}
                onClick={() => void state.move("group", selectedSection.groups.map((group) => group.id), selectedGroupIndex, -1)}
                type="button"
              >
                <span className="inline-flex items-center gap-2"><ArrowUp className="h-4 w-4" />Move Up</span>
              </button>
              <button
                className="rounded-xl border border-borderSoft/80 bg-panelSoft/65 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft disabled:opacity-50"
                disabled={selectedGroupIndex < 0 || selectedGroupIndex >= selectedSection.groups.length - 1}
                onClick={() => void state.move("group", selectedSection.groups.map((group) => group.id), selectedGroupIndex, 1)}
                type="button"
              >
                <span className="inline-flex items-center gap-2"><ArrowDown className="h-4 w-4" />Move Down</span>
              </button>
              <button
                className="rounded-xl bg-accent px-3 py-2 text-sm font-medium text-slate-950 transition hover:brightness-110"
                onClick={() => void state.saveGroup(selectedGroup.id, {
                  title: selectedGroup.title,
                  rankingWindowDefault: selectedGroup.rankingWindowDefault,
                  showSparkline: selectedGroup.showSparkline,
                  pinTop10: selectedGroup.pinTop10,
                  columns: selectedGroup.columns,
                })}
                type="button"
              >
                <span className="inline-flex items-center gap-2"><Save className="h-4 w-4" />Save Group</span>
              </button>
              <button
                className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100 transition hover:bg-rose-500/20"
                onClick={() => setDeleteIntent({ type: "group", id: selectedGroup.id, title: selectedGroup.title })}
                type="button"
              >
                <span className="inline-flex items-center gap-2"><Trash2 className="h-4 w-4" />Delete Group</span>
              </button>
            </>
          ) : null}
        >
          {selectedGroup && selectedSection ? (
            <div className="space-y-5">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr),12rem,12rem]">
                <label className="text-xs text-slate-300">
                  Group title
                  <input
                    className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                    value={selectedGroup.title}
                    onChange={(event) => state.updateGroupDraft(selectedSection.id, selectedGroup.id, { title: event.target.value })}
                  />
                </label>
                <label className="text-xs text-slate-300">
                  Ranking window
                  <select
                    className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                    value={selectedGroup.rankingWindowDefault}
                    onChange={(event) => state.updateGroupDraft(selectedSection.id, selectedGroup.id, { rankingWindowDefault: event.target.value })}
                  >
                    {rankingOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 rounded-2xl border border-borderSoft/70 bg-panelSoft/45 px-4 py-3 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={selectedGroup.pinTop10}
                    onChange={(event) => state.updateGroupDraft(selectedSection.id, selectedGroup.id, { pinTop10: event.target.checked })}
                  />
                  Pin top 10 rows
                </label>
              </div>

              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Columns</p>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {allColumns.map((column) => {
                    const isChecked = selectedGroup.columns.includes(column);
                    return (
                      <label key={column} className="flex items-center gap-2 rounded-2xl border border-borderSoft/70 bg-panelSoft/45 px-3 py-3 text-sm text-slate-300">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(event) => {
                            const nextColumns = event.target.checked
                              ? [...selectedGroup.columns, column]
                              : selectedGroup.columns.filter((entry) => entry !== column);
                            state.updateGroupDraft(selectedSection.id, selectedGroup.id, { columns: nextColumns });
                          }}
                        />
                        {column}
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Add tickers</p>
                <div className="flex flex-wrap gap-3">
                  <input
                    className="h-11 min-w-[18rem] flex-1 rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                    value={state.tickerInput[selectedGroup.id] ?? ""}
                    onChange={(event) => state.setTickerInput((current) => ({ ...current, [selectedGroup.id]: event.target.value }))}
                    placeholder="Add tickers: XBI, TLT, EFA"
                  />
                  <button
                    className="rounded-2xl bg-accent px-4 py-2 text-sm font-medium text-slate-950 transition hover:brightness-110"
                    onClick={() => void state.addTicker(selectedGroup.id)}
                    type="button"
                  >
                    Add Tickers
                  </button>
                </div>
                {state.tickerErrors[selectedGroup.id] ? <InlineAlert tone="danger">{state.tickerErrors[selectedGroup.id]}</InlineAlert> : null}
              </div>

              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Ticker list</p>
                {selectedGroup.items.length === 0 ? (
                  <EmptyState title="No tickers in this group" description="Add one or more tickers to start populating the group." />
                ) : (
                  <div className="space-y-3">
                    {selectedGroup.items.map((item, index) => (
                      <div key={item.id} className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 px-4 py-4">
                        <div className="flex flex-wrap items-center gap-3">
                          <div className="min-w-12 text-sm font-semibold text-accent">{item.ticker}</div>
                          <input
                            className="h-10 min-w-[18rem] flex-1 rounded-xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                            value={state.itemDisplayNames[item.id] ?? ""}
                            onChange={(event) => state.setItemDisplayNameDraft(item.id, event.target.value)}
                            placeholder="Display name"
                          />
                          <button
                            className="rounded-xl border border-borderSoft/80 bg-panelSoft/70 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft"
                            onClick={() => void state.updateItemDisplayName(item.id)}
                            type="button"
                          >
                            Save Name
                          </button>
                          <button
                            className="rounded-xl border border-borderSoft/80 bg-panelSoft/70 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft disabled:opacity-50"
                            disabled={index === 0}
                            onClick={() => void state.move("item", selectedGroup.items.map((groupItem) => groupItem.id), index, -1)}
                            type="button"
                          >
                            <ArrowUp className="h-4 w-4" />
                          </button>
                          <button
                            className="rounded-xl border border-borderSoft/80 bg-panelSoft/70 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft disabled:opacity-50"
                            disabled={index === selectedGroup.items.length - 1}
                            onClick={() => void state.move("item", selectedGroup.items.map((groupItem) => groupItem.id), index, 1)}
                            type="button"
                          >
                            <ArrowDown className="h-4 w-4" />
                          </button>
                          <button
                            className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100 transition hover:bg-rose-500/20"
                            onClick={() => setDeleteIntent({ type: "item", id: item.id, title: item.ticker })}
                            type="button"
                          >
                            Delete
                          </button>
                        </div>
                        {state.itemDisplayNameStatus[item.id] ? (
                          <p className={`mt-3 text-xs ${
                            state.itemDisplayNameStatus[item.id]?.includes("Saved")
                              ? "text-emerald-300"
                              : state.itemDisplayNameStatus[item.id]?.includes("No database")
                                ? "text-slate-400"
                                : "text-rose-300"
                          }`}>
                            {state.itemDisplayNameStatus[item.id]}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <EmptyState title="Select a group" description="Choose a group from the middle column to edit its settings and tickers." />
          )}
        </AdminCard>
      </div>

      <ConfirmDialog
        open={Boolean(deleteIntent)}
        title={
          deleteIntent?.type === "section"
            ? "Delete section?"
            : deleteIntent?.type === "group"
              ? "Delete group?"
              : "Delete ticker?"
        }
        description={
          deleteIntent?.type === "section"
            ? `Delete "${deleteIntent.title}" and all of its groups?`
            : deleteIntent?.type === "group"
              ? `Delete "${deleteIntent.title}" and all of its tickers?`
              : `Remove ${deleteIntent?.title ?? "this ticker"} from the selected group?`
        }
        confirmLabel="Delete"
        tone="danger"
        busy={deleteBusy}
        onCancel={() => setDeleteIntent(null)}
        onConfirm={handleDelete}
      />
    </>
  );
}
