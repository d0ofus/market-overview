"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createAdminPromptVersion,
  createAdminResearchProfile,
  createAdminResearchProfileVersion,
  createAdminRubricVersion,
  createAdminSearchTemplateVersion,
  getAdminResearchProfiles,
  updateAdminResearchProfile,
  type PromptVersionRow,
  type ResearchProfileRow,
  type ResearchProfileSettings,
  type RubricVersionRow,
  type SearchTemplateVersionRow,
} from "@/lib/api";

type PromptKind = "haiku_extract" | "sonnet_rank" | "sonnet_deep_dive";

const DEFAULT_SETTINGS: ResearchProfileSettings = {
  lookbackDays: 14,
  includeMacroContext: true,
  maxTickerQueries: 4,
  maxEvidenceItemsPerTicker: 12,
  maxSearchResultsPerQuery: 4,
  maxTickersPerRun: 20,
  deepDiveTopN: 3,
  comparisonEnabled: true,
  sourceFamilies: {
    sec: true,
    news: true,
    earningsTranscripts: true,
    investorRelations: true,
    analystCommentary: true,
  },
};

export function ResearchAdminPanel() {
  const [profiles, setProfiles] = useState<ResearchProfileRow[]>([]);
  const [promptVersions, setPromptVersions] = useState<PromptVersionRow[]>([]);
  const [rubricVersions, setRubricVersions] = useState<RubricVersionRow[]>([]);
  const [searchTemplateVersions, setSearchTemplateVersions] = useState<SearchTemplateVersionRow[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [creatingProfile, setCreatingProfile] = useState({ slug: "", name: "", description: "" });
  const [versionDraft, setVersionDraft] = useState({
    promptVersionIdHaiku: "",
    promptVersionIdSonnetRank: "",
    promptVersionIdSonnetDeepDive: "",
    rubricVersionId: "",
    searchTemplateVersionId: "",
    settings: DEFAULT_SETTINGS,
  });
  const [advancedDrafts, setAdvancedDrafts] = useState<{
    prompt: { promptKind: PromptKind; label: string; modelFamily: string; templateText: string; templateJson: string };
    rubric: { label: string; rubricJson: string };
    search: { label: string; templateJson: string };
  }>({
    prompt: { promptKind: "haiku_extract", label: "", modelFamily: "haiku-4.5", templateText: "", templateJson: "{\"responseShape\":\"research-card\"}" },
    rubric: { label: "", rubricJson: "{\"weights\":{}}" },
    search: { label: "", templateJson: "{\"tickerFamilies\":[],\"macroFamilies\":[]}" },
  });

  const load = async (preferredId?: string | null) => {
    try {
      const payload = await getAdminResearchProfiles();
      setProfiles(payload.profiles);
      setPromptVersions(payload.promptVersions);
      setRubricVersions(payload.rubricVersions);
      setSearchTemplateVersions(payload.searchTemplateVersions);
      const nextId = preferredId ?? selectedProfileId ?? payload.profiles[0]?.id ?? null;
      setSelectedProfileId(nextId);
      const currentProfile = payload.profiles.find((profile) => profile.id === nextId) ?? payload.profiles[0] ?? null;
      setVersionDraft({
        promptVersionIdHaiku: currentProfile?.currentVersion?.promptVersionIdHaiku ?? payload.promptVersions.find((row) => row.promptKind === "haiku_extract")?.id ?? "",
        promptVersionIdSonnetRank: currentProfile?.currentVersion?.promptVersionIdSonnetRank ?? payload.promptVersions.find((row) => row.promptKind === "sonnet_rank")?.id ?? "",
        promptVersionIdSonnetDeepDive: currentProfile?.currentVersion?.promptVersionIdSonnetDeepDive ?? payload.promptVersions.find((row) => row.promptKind === "sonnet_deep_dive")?.id ?? "",
        rubricVersionId: currentProfile?.currentVersion?.rubricVersionId ?? payload.rubricVersions[0]?.id ?? "",
        searchTemplateVersionId: currentProfile?.currentVersion?.searchTemplateVersionId ?? payload.searchTemplateVersions[0]?.id ?? "",
        settings: currentProfile?.currentVersion?.settings ?? DEFAULT_SETTINGS,
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load research admin data.");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  );

  const updateSetting = <K extends keyof ResearchProfileSettings>(key: K, value: ResearchProfileSettings[K]) => {
    setVersionDraft((current) => ({
      ...current,
      settings: {
        ...current.settings,
        [key]: value,
      },
    }));
  };

  return (
    <section className="space-y-4">
      {message && <div className="card border border-borderSoft/70 p-3 text-sm text-slate-300">{message}</div>}

      <div className="grid gap-4 xl:grid-cols-[18rem,minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="card p-3">
            <div className="mb-3 text-sm font-semibold text-slate-200">Profiles</div>
            <div className="space-y-2">
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  className={`w-full rounded border px-3 py-2 text-left ${profile.id === selectedProfileId ? "border-accent/60 bg-accent/10" : "border-borderSoft/60 hover:bg-slate-900/30"}`}
                  onClick={() => setSelectedProfileId(profile.id)}
                  type="button"
                >
                  <div className="text-sm font-semibold text-accent">{profile.name}</div>
                  <div className="text-[11px] text-slate-400">v{profile.currentVersion?.versionNumber ?? "-"} · {profile.isDefault ? "default" : "active"}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="card p-3">
            <div className="mb-2 text-sm font-semibold text-slate-200">New Profile</div>
            <div className="space-y-2">
              <input className="w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" placeholder="Slug" value={creatingProfile.slug} onChange={(event) => setCreatingProfile((current) => ({ ...current, slug: event.target.value }))} />
              <input className="w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" placeholder="Name" value={creatingProfile.name} onChange={(event) => setCreatingProfile((current) => ({ ...current, name: event.target.value }))} />
              <textarea className="min-h-20 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" placeholder="Description" value={creatingProfile.description} onChange={(event) => setCreatingProfile((current) => ({ ...current, description: event.target.value }))} />
              <button
                className="rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-sm text-accent"
                onClick={async () => {
                  try {
                    const created = await createAdminResearchProfile({
                      slug: creatingProfile.slug,
                      name: creatingProfile.name,
                      description: creatingProfile.description || null,
                    });
                    setCreatingProfile({ slug: "", name: "", description: "" });
                    setMessage("Research profile created.");
                    await load(created.id);
                  } catch (error) {
                    setMessage(error instanceof Error ? error.message : "Failed to create research profile.");
                  }
                }}
                type="button"
              >
                Create Profile
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {selectedProfile && (
            <div className="card p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold text-slate-200">{selectedProfile.name}</div>
                  <div className="text-sm text-slate-400">{selectedProfile.description ?? "No description"}</div>
                </div>
                <button
                  className="rounded border border-borderSoft px-3 py-1.5 text-sm text-slate-300"
                  onClick={async () => {
                    try {
                      await updateAdminResearchProfile(selectedProfile.id, { isDefault: !selectedProfile.isDefault });
                      setMessage(selectedProfile.isDefault ? "Default profile cleared." : "Default profile updated.");
                      await load(selectedProfile.id);
                    } catch (error) {
                      setMessage(error instanceof Error ? error.message : "Failed to update profile.");
                    }
                  }}
                  type="button"
                >
                  {selectedProfile.isDefault ? "Unset Default" : "Make Default"}
                </button>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-xs text-slate-300">
                  Haiku Prompt Version
                  <select className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm" value={versionDraft.promptVersionIdHaiku} onChange={(event) => setVersionDraft((current) => ({ ...current, promptVersionIdHaiku: event.target.value }))}>
                    {promptVersions.filter((row) => row.promptKind === "haiku_extract").map((row) => <option key={row.id} value={row.id}>{row.label} (v{row.versionNumber})</option>)}
                  </select>
                </label>
                <label className="text-xs text-slate-300">
                  Sonnet Rank Version
                  <select className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm" value={versionDraft.promptVersionIdSonnetRank} onChange={(event) => setVersionDraft((current) => ({ ...current, promptVersionIdSonnetRank: event.target.value }))}>
                    {promptVersions.filter((row) => row.promptKind === "sonnet_rank").map((row) => <option key={row.id} value={row.id}>{row.label} (v{row.versionNumber})</option>)}
                  </select>
                </label>
                <label className="text-xs text-slate-300">
                  Sonnet Deep Dive Version
                  <select className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm" value={versionDraft.promptVersionIdSonnetDeepDive} onChange={(event) => setVersionDraft((current) => ({ ...current, promptVersionIdSonnetDeepDive: event.target.value }))}>
                    {promptVersions.filter((row) => row.promptKind === "sonnet_deep_dive").map((row) => <option key={row.id} value={row.id}>{row.label} (v{row.versionNumber})</option>)}
                  </select>
                </label>
                <label className="text-xs text-slate-300">
                  Rubric Version
                  <select className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm" value={versionDraft.rubricVersionId} onChange={(event) => setVersionDraft((current) => ({ ...current, rubricVersionId: event.target.value }))}>
                    {rubricVersions.map((row) => <option key={row.id} value={row.id}>{row.label} (v{row.versionNumber})</option>)}
                  </select>
                </label>
                <label className="text-xs text-slate-300 md:col-span-2">
                  Search Template Version
                  <select className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm" value={versionDraft.searchTemplateVersionId} onChange={(event) => setVersionDraft((current) => ({ ...current, searchTemplateVersionId: event.target.value }))}>
                    {searchTemplateVersions.map((row) => <option key={row.id} value={row.id}>{row.label} (v{row.versionNumber})</option>)}
                  </select>
                </label>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-4">
                <label className="text-xs text-slate-300">
                  Lookback Days
                  <input className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm" type="number" value={versionDraft.settings.lookbackDays} onChange={(event) => updateSetting("lookbackDays", Number(event.target.value || 1))} />
                </label>
                <label className="text-xs text-slate-300">
                  Max Ticker Queries
                  <input className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm" type="number" value={versionDraft.settings.maxTickerQueries} onChange={(event) => updateSetting("maxTickerQueries", Number(event.target.value || 1))} />
                </label>
                <label className="text-xs text-slate-300">
                  Max Evidence / Ticker
                  <input className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm" type="number" value={versionDraft.settings.maxEvidenceItemsPerTicker} onChange={(event) => updateSetting("maxEvidenceItemsPerTicker", Number(event.target.value || 1))} />
                </label>
                <label className="text-xs text-slate-300">
                  Default Deep Dive Top N
                  <input className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm" type="number" value={versionDraft.settings.deepDiveTopN} onChange={(event) => updateSetting("deepDiveTopN", Number(event.target.value || 0))} />
                </label>
              </div>

              <div className="mt-3 flex flex-wrap gap-3 text-sm text-slate-300">
                <label className="flex items-center gap-2"><input type="checkbox" checked={versionDraft.settings.includeMacroContext} onChange={(event) => updateSetting("includeMacroContext", event.target.checked)} />Include Macro Context</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={versionDraft.settings.comparisonEnabled} onChange={(event) => updateSetting("comparisonEnabled", event.target.checked)} />Enable Compare vs Prior</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={versionDraft.settings.sourceFamilies.news} onChange={(event) => setVersionDraft((current) => ({ ...current, settings: { ...current.settings, sourceFamilies: { ...current.settings.sourceFamilies, news: event.target.checked } } }))} />News</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={versionDraft.settings.sourceFamilies.earningsTranscripts} onChange={(event) => setVersionDraft((current) => ({ ...current, settings: { ...current.settings, sourceFamilies: { ...current.settings.sourceFamilies, earningsTranscripts: event.target.checked } } }))} />Transcripts</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={versionDraft.settings.sourceFamilies.investorRelations} onChange={(event) => setVersionDraft((current) => ({ ...current, settings: { ...current.settings, sourceFamilies: { ...current.settings.sourceFamilies, investorRelations: event.target.checked } } }))} />IR</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={versionDraft.settings.sourceFamilies.analystCommentary} onChange={(event) => setVersionDraft((current) => ({ ...current, settings: { ...current.settings, sourceFamilies: { ...current.settings.sourceFamilies, analystCommentary: event.target.checked } } }))} />Analyst</label>
              </div>

              <div className="mt-4 flex gap-2">
                <button
                  className="rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-sm text-accent"
                  onClick={async () => {
                    try {
                      await createAdminResearchProfileVersion(selectedProfile.id, { ...versionDraft, activate: true });
                      setMessage("Research profile version created and activated.");
                      await load(selectedProfile.id);
                    } catch (error) {
                      setMessage(error instanceof Error ? error.message : "Failed to create research profile version.");
                    }
                  }}
                  type="button"
                >
                  Create New Version
                </button>
              </div>
            </div>
          )}

          <div className="card p-4">
            <div className="mb-3 text-sm font-semibold text-slate-200">Advanced Versioning</div>
            <div className="grid gap-4 xl:grid-cols-3">
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Prompt Version</div>
                <input className="w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" placeholder="Label" value={advancedDrafts.prompt.label} onChange={(event) => setAdvancedDrafts((current) => ({ ...current, prompt: { ...current.prompt, label: event.target.value } }))} />
                <select className="w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" value={advancedDrafts.prompt.promptKind} onChange={(event) => setAdvancedDrafts((current) => ({ ...current, prompt: { ...current.prompt, promptKind: event.target.value as "haiku_extract" | "sonnet_rank" | "sonnet_deep_dive" } }))}>
                  <option value="haiku_extract">Haiku Extract</option>
                  <option value="sonnet_rank">Sonnet Rank</option>
                  <option value="sonnet_deep_dive">Sonnet Deep Dive</option>
                </select>
                <input className="w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" placeholder="Model family" value={advancedDrafts.prompt.modelFamily} onChange={(event) => setAdvancedDrafts((current) => ({ ...current, prompt: { ...current.prompt, modelFamily: event.target.value } }))} />
                <textarea className="min-h-24 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" placeholder="Template text" value={advancedDrafts.prompt.templateText} onChange={(event) => setAdvancedDrafts((current) => ({ ...current, prompt: { ...current.prompt, templateText: event.target.value } }))} />
                <textarea className="min-h-24 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 font-mono text-xs" value={advancedDrafts.prompt.templateJson} onChange={(event) => setAdvancedDrafts((current) => ({ ...current, prompt: { ...current.prompt, templateJson: event.target.value } }))} />
                <button className="rounded border border-borderSoft px-3 py-1.5 text-sm text-slate-300" onClick={async () => {
                  try {
                    await createAdminPromptVersion({
                      promptKind: advancedDrafts.prompt.promptKind,
                      label: advancedDrafts.prompt.label,
                      modelFamily: advancedDrafts.prompt.modelFamily,
                      templateText: advancedDrafts.prompt.templateText || null,
                      templateJson: JSON.parse(advancedDrafts.prompt.templateJson),
                    });
                    setMessage("Prompt version created.");
                    await load(selectedProfileId);
                  } catch (error) {
                    setMessage(error instanceof Error ? error.message : "Failed to create prompt version.");
                  }
                }} type="button">Create Prompt Version</button>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Rubric Version</div>
                <input className="w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" placeholder="Label" value={advancedDrafts.rubric.label} onChange={(event) => setAdvancedDrafts((current) => ({ ...current, rubric: { ...current.rubric, label: event.target.value } }))} />
                <textarea className="min-h-44 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 font-mono text-xs" value={advancedDrafts.rubric.rubricJson} onChange={(event) => setAdvancedDrafts((current) => ({ ...current, rubric: { ...current.rubric, rubricJson: event.target.value } }))} />
                <button className="rounded border border-borderSoft px-3 py-1.5 text-sm text-slate-300" onClick={async () => {
                  try {
                    await createAdminRubricVersion({
                      label: advancedDrafts.rubric.label,
                      rubricJson: JSON.parse(advancedDrafts.rubric.rubricJson),
                    });
                    setMessage("Rubric version created.");
                    await load(selectedProfileId);
                  } catch (error) {
                    setMessage(error instanceof Error ? error.message : "Failed to create rubric version.");
                  }
                }} type="button">Create Rubric Version</button>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Search Template Version</div>
                <input className="w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm" placeholder="Label" value={advancedDrafts.search.label} onChange={(event) => setAdvancedDrafts((current) => ({ ...current, search: { ...current.search, label: event.target.value } }))} />
                <textarea className="min-h-44 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 font-mono text-xs" value={advancedDrafts.search.templateJson} onChange={(event) => setAdvancedDrafts((current) => ({ ...current, search: { ...current.search, templateJson: event.target.value } }))} />
                <button className="rounded border border-borderSoft px-3 py-1.5 text-sm text-slate-300" onClick={async () => {
                  try {
                    await createAdminSearchTemplateVersion({
                      label: advancedDrafts.search.label,
                      templateJson: JSON.parse(advancedDrafts.search.templateJson),
                    });
                    setMessage("Search template version created.");
                    await load(selectedProfileId);
                  } catch (error) {
                    setMessage(error instanceof Error ? error.message : "Failed to create search template version.");
                  }
                }} type="button">Create Search Template Version</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
