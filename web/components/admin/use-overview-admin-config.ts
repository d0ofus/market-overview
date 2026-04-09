"use client";

import { useEffect, useMemo, useState } from "react";
import { adminFetch } from "@/lib/api";
import type { OverviewAdminConfig } from "./overview-admin-shared";

type Message = {
  tone: "success" | "danger" | "info";
  text: string;
} | null;

export function useOverviewAdminConfig() {
  const [data, setData] = useState<OverviewAdminConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tickerInput, setTickerInput] = useState<Record<string, string>>({});
  const [newSectionTitle, setNewSectionTitle] = useState("");
  const [newGroupTitle, setNewGroupTitle] = useState<Record<string, string>>({});
  const [tickerErrors, setTickerErrors] = useState<Record<string, string | null>>({});
  const [itemDisplayNames, setItemDisplayNames] = useState<Record<string, string>>({});
  const [itemDisplayNameStatus, setItemDisplayNameStatus] = useState<Record<string, string | null>>({});
  const [message, setMessage] = useState<Message>(null);

  const load = async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!silent) setIsLoading(true);
    setLoadError(null);
    try {
      const config = await adminFetch<OverviewAdminConfig>("/api/admin/config");
      setData(config);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to load admin config.");
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!data) return;
    const next: Record<string, string> = {};
    for (const section of data.sections) {
      for (const group of section.groups) {
        for (const item of group.items) {
          next[item.id] = item.displayName ?? "";
        }
      }
    }
    setItemDisplayNames(next);
  }, [data]);

  const itemMetaById = useMemo(() => {
    const next = new Map<string, { ticker: string; groupTitle: string }>();
    if (!data) return next;
    for (const section of data.sections) {
      for (const group of section.groups) {
        for (const item of group.items) {
          next.set(item.id, { ticker: item.ticker, groupTitle: group.title });
        }
      }
    }
    return next;
  }, [data]);

  const updateGroupDraft = (sectionId: string, groupId: string, patch: Record<string, unknown>) => {
    setData((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      const target = next.sections.find((section) => section.id === sectionId)?.groups.find((group) => group.id === groupId);
      if (!target) return current;
      Object.assign(target, patch);
      return next;
    });
  };

  const removeItemDraft = (itemId: string) => {
    setData((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      for (const section of next.sections) {
        for (const group of section.groups) {
          const existingLength = group.items.length;
          group.items = group.items.filter((item) => item.id !== itemId);
          if (group.items.length !== existingLength) {
            return next;
          }
        }
      }
      return current;
    });
    setItemDisplayNames((current) => {
      const next = { ...current };
      delete next[itemId];
      return next;
    });
    setItemDisplayNameStatus((current) => {
      const next = { ...current };
      delete next[itemId];
      return next;
    });
  };

  const removeGroupDraft = (groupId: string) => {
    setData((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      for (const section of next.sections) {
        const existingLength = section.groups.length;
        section.groups = section.groups.filter((group) => group.id !== groupId);
        if (section.groups.length !== existingLength) {
          return next;
        }
      }
      return current;
    });
  };

  const removeSectionDraft = (sectionId: string) => {
    setData((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      const filtered = next.sections.filter((section) => section.id !== sectionId);
      if (filtered.length === next.sections.length) return current;
      next.sections = filtered;
      return next;
    });
  };

  const setItemDisplayNameDraft = (itemId: string, value: string) => {
    setItemDisplayNames((current) => ({ ...current, [itemId]: value }));
  };

  const flashMessage = (next: NonNullable<Message>, timeoutMs = 4000) => {
    setMessage(next);
    window.setTimeout(() => {
      setMessage((current) => (current?.text === next.text ? null : current));
    }, timeoutMs);
  };

  const saveGroup = async (groupId: string, payload: {
    title: string;
    rankingWindowDefault: string;
    showSparkline: boolean;
    pinTop10: boolean;
    columns: string[];
  }) => {
    try {
      await adminFetch("/api/admin/group/" + groupId, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      await load();
      flashMessage({ tone: "success", text: "Group configuration updated." });
    } catch (error) {
      flashMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to update group." }, 5000);
    }
  };

  const addTicker = async (groupId: string) => {
    const list = (tickerInput[groupId] ?? "")
      .split(",")
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);

    setTickerErrors((current) => ({ ...current, [groupId]: null }));
    const failures: string[] = [];

    for (const ticker of list) {
      try {
        await adminFetch("/api/admin/group/" + groupId + "/items", {
          method: "POST",
          body: JSON.stringify({ ticker, tags: [] }),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        failures.push(`${ticker} (${detail})`);
      }
    }

    setTickerInput((current) => ({ ...current, [groupId]: "" }));
    await load();
    if (list.length > 0 && failures.length < list.length) {
      flashMessage({
        tone: "success",
        text: `Added ${list.length - failures.length} ticker${list.length - failures.length === 1 ? "" : "s"}.`,
      });
    }
    if (failures.length > 0) {
      setTickerErrors((current) => ({ ...current, [groupId]: `Could not add: ${failures.join(" | ")}` }));
      flashMessage({ tone: "danger", text: "One or more tickers could not be added." }, 5000);
    }
  };

  const removeItem = async (itemId: string) => {
    try {
      await adminFetch("/api/admin/item/" + itemId, { method: "DELETE" });
      removeItemDraft(itemId);
      flashMessage({ tone: "success", text: "Ticker removed from group." });
      void load({ silent: true });
    } catch (error) {
      flashMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to delete item." }, 5000);
    }
  };

  const updateItemDisplayName = async (itemId: string) => {
    try {
      setItemDisplayNameStatus((current) => ({ ...current, [itemId]: null }));
      const result = await adminFetch<{ ok: boolean; itemId: string; updated: boolean; reason?: string }>("/api/admin/item/" + itemId, {
        method: "PATCH",
        body: JSON.stringify({ displayName: (itemDisplayNames[itemId] ?? "").trim() || null }),
      });
      if (result.reason === "managed_by_etf_universe") {
        setItemDisplayNameStatus((current) => ({ ...current, [itemId]: "Managed from ETF Universe." }));
        flashMessage({ tone: "info", text: "This ticker name is managed from ETF Universe." });
        await load({ silent: true });
        return;
      }
      if (result.updated) {
        setItemDisplayNameStatus((current) => ({ ...current, [itemId]: "Saved to database." }));
        const meta = itemMetaById.get(itemId);
        flashMessage({
          tone: "success",
          text: meta ? `Saved ${meta.ticker} display name.` : "Display name saved.",
        });
        await load({ silent: true });
      } else {
        setItemDisplayNameStatus((current) => ({ ...current, [itemId]: "No database change needed." }));
        flashMessage({ tone: "info", text: "No database change needed." });
      }
    } catch (error) {
      setItemDisplayNameStatus((current) => ({
        ...current,
        [itemId]: error instanceof Error ? error.message : "Failed to save name.",
      }));
    } finally {
      window.setTimeout(() => {
        setItemDisplayNameStatus((current) => ({ ...current, [itemId]: null }));
      }, 6000);
    }
  };

  const addSection = async () => {
    if (!newSectionTitle.trim()) return;
    try {
      await adminFetch("/api/admin/section", {
        method: "POST",
        body: JSON.stringify({ title: newSectionTitle.trim() }),
      });
      setNewSectionTitle("");
      await load();
      flashMessage({ tone: "success", text: "Section created." });
    } catch (error) {
      flashMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to add section." }, 5000);
    }
  };

  const addGroup = async (sectionId: string) => {
    const title = (newGroupTitle[sectionId] ?? "").trim();
    if (!title) return;
    try {
      await adminFetch("/api/admin/section/" + sectionId + "/group", {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      setNewGroupTitle((current) => ({ ...current, [sectionId]: "" }));
      await load();
      flashMessage({ tone: "success", text: "Group created." });
    } catch (error) {
      flashMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to add group." }, 5000);
    }
  };

  const move = async (type: "group" | "item", ids: string[], index: number, dir: -1 | 1) => {
    const to = index + dir;
    if (to < 0 || to >= ids.length) return;
    const next = [...ids];
    const [element] = next.splice(index, 1);
    next.splice(to, 0, element);
    try {
      await adminFetch("/api/admin/reorder", {
        method: "POST",
        body: JSON.stringify({ type, orderedIds: next }),
      });
      await load();
      flashMessage({ tone: "success", text: `${type === "group" ? "Group" : "Ticker"} order updated.` });
    } catch (error) {
      flashMessage({ tone: "danger", text: error instanceof Error ? error.message : `Failed to reorder ${type}.` }, 5000);
    }
  };

  const deleteSection = async (sectionId: string) => {
    try {
      await adminFetch("/api/admin/section/" + sectionId, { method: "DELETE" });
      removeSectionDraft(sectionId);
      flashMessage({ tone: "success", text: "Section deleted." });
      void load({ silent: true });
    } catch (error) {
      flashMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to delete section." }, 5000);
    }
  };

  const deleteGroup = async (groupId: string) => {
    try {
      await adminFetch("/api/admin/group/" + groupId, { method: "DELETE" });
      removeGroupDraft(groupId);
      flashMessage({ tone: "success", text: "Group deleted." });
      void load({ silent: true });
    } catch (error) {
      flashMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to delete group." }, 5000);
    }
  };

  return {
    data,
    isLoading,
    loadError,
    message,
    setMessage,
    load,
    tickerInput,
    setTickerInput,
    newSectionTitle,
    setNewSectionTitle,
    newGroupTitle,
    setNewGroupTitle,
    tickerErrors,
    itemDisplayNames,
    itemDisplayNameStatus,
    setItemDisplayNameDraft,
    setData,
    updateGroupDraft,
    saveGroup,
    addTicker,
    removeItem,
    updateItemDisplayName,
    addSection,
    addGroup,
    move,
    deleteSection,
    deleteGroup,
  };
}
