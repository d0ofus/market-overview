"use client";

import { useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { PeerGroupRow } from "@/lib/api";

type PeerGroupFilterPickerProps = {
  groups: PeerGroupRow[];
  value: string;
  onChange: (groupId: string) => void;
  disabled?: boolean;
  maxVisible?: number;
};

const DEFAULT_MAX_VISIBLE = 12;

function groupMatchesQuery(group: PeerGroupRow, normalizedQuery: string) {
  if (!normalizedQuery) return true;
  return [group.name, group.description, group.groupType]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalizedQuery));
}

export function PeerGroupFilterPicker({
  groups,
  value,
  onChange,
  disabled = false,
  maxVisible = DEFAULT_MAX_VISIBLE,
}: PeerGroupFilterPickerProps) {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === value) ?? null,
    [groups, value],
  );

  const normalizedQuery = query.trim().toLowerCase();
  const matchingGroups = useMemo(
    () => groups.filter((group) => groupMatchesQuery(group, normalizedQuery)),
    [groups, normalizedQuery],
  );
  const visibleGroups = useMemo(
    () => matchingGroups.slice(0, maxVisible),
    [matchingGroups, maxVisible],
  );

  const handleSelect = (nextGroupId: string) => {
    onChange(nextGroupId);
    setQuery("");
    setIsOpen(false);
  };

  return (
    <div className="text-xs text-slate-300">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span>Filter by peer group</span>
        {selectedGroup ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[11px] text-slate-400 transition hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              handleSelect("");
              inputRef.current?.focus();
            }}
            disabled={disabled}
          >
            <X className="h-3 w-3" />
            Clear
          </button>
        ) : null}
      </div>

      <div className="overflow-hidden rounded border border-borderSoft bg-panelSoft">
        <div className="flex items-center gap-2 border-b border-borderSoft/70 px-2">
          <Search className="h-4 w-4 text-slate-400" />
          <input
            ref={inputRef}
            className="min-h-9 w-full bg-transparent py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 disabled:cursor-not-allowed disabled:opacity-60"
            value={query}
            onFocus={() => setIsOpen(true)}
            onChange={(event) => {
              setQuery(event.target.value);
              setIsOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && visibleGroups[0]) {
                event.preventDefault();
                handleSelect(visibleGroups[0].id);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setQuery("");
                setIsOpen(false);
              }
            }}
            disabled={disabled}
            placeholder={selectedGroup ? selectedGroup.name : "Search groups..."}
            aria-label="Search peer groups"
          />
        </div>

        {isOpen ? (
          <div className="max-h-60 overflow-auto p-1" role="listbox" aria-label="Peer group filter options">
            <button
              type="button"
              className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm transition ${
                value === "" ? "bg-accent/15 text-accent" : "text-slate-300 hover:bg-slate-800/60"
              }`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => handleSelect("")}
              disabled={disabled}
              role="option"
              aria-selected={value === ""}
            >
              <span>All Groups</span>
            </button>

            {visibleGroups.map((group) => (
              <button
                key={group.id}
                type="button"
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition ${
                  value === group.id ? "bg-accent/15 text-accent" : "text-slate-300 hover:bg-slate-800/60"
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handleSelect(group.id)}
                disabled={disabled}
                role="option"
                aria-selected={value === group.id}
                title={group.name}
              >
                <span className="min-w-0 flex-1 truncate">{group.name}</span>
                {typeof group.memberCount === "number" ? (
                  <span className="shrink-0 text-[11px] text-slate-500">{group.memberCount}</span>
                ) : null}
              </button>
            ))}

            {visibleGroups.length === 0 ? (
              <div className="px-2 py-3 text-center text-xs text-slate-500">No matching groups.</div>
            ) : null}

            {matchingGroups.length > visibleGroups.length ? (
              <div className="px-2 py-1.5 text-center text-[11px] text-slate-500">
                Showing {visibleGroups.length} of {matchingGroups.length}. Keep typing to narrow.
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mt-1 text-[11px] text-slate-500">
        {selectedGroup
          ? `Selected: ${selectedGroup.name}`
          : normalizedQuery
            ? `${matchingGroups.length} match${matchingGroups.length === 1 ? "" : "es"}; Enter selects first`
            : `${matchingGroups.length} group${matchingGroups.length === 1 ? "" : "s"} available`}
      </div>
    </div>
  );
}
