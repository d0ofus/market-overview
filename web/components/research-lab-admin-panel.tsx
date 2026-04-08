"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createAdminResearchLabProfile,
  createAdminResearchLabProfileVersion,
  getAdminResearchLabProfiles,
  updateAdminResearchLabProfile,
  type ResearchLabProfileDetail,
  type ResearchLabProfileVersionRecord,
} from "@/lib/research-lab-api";
import { AdminCard } from "@/components/admin/admin-card";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminStatCard } from "@/components/admin/admin-stat-card";
import { EmptyState } from "@/components/admin/empty-state";
import { InlineAlert } from "@/components/admin/inline-alert";

function prettyJson(value: Record<string, unknown> | null | undefined, fallback: Record<string, unknown>) {
  return JSON.stringify(value ?? fallback, null, 2);
}

const DEFAULT_EVIDENCE_CONFIG = {
  lookbackDays: 21,
  maxItemsPerQuery: 2,
  maxItemsForPrompt: 10,
  evidenceTarget: 8,
  maxQueryFamilies: 4,
  forceFreshSearch: false,
  families: [],
};

const DEFAULT_SYNTHESIS_CONFIG = {
  maxEvidenceItems: 8,
  maxItemsPerFamily: 2,
  additionalInstructions: "",
};

const DEFAULT_MODULES_CONFIG = {
  keyDrivers: {
    enabled: false,
    maxDrivers: 3,
    requirePriceRelationship: true,
    priceWindow: "90d",
  },
};

type EditorTab = "profile" | "prompt" | "evidence" | "synthesis" | "modules" | "versions";

const EDITOR_TABS: Array<{ key: EditorTab; label: string }> = [
  { key: "profile", label: "Profile" },
  { key: "prompt", label: "Prompt" },
  { key: "evidence", label: "Evidence" },
  { key: "synthesis", label: "Synthesis" },
  { key: "modules", label: "Modules" },
  { key: "versions", label: "Versions" },
];

export function ResearchLabAdminPanel() {
  const [profiles, setProfiles] = useState<ResearchLabProfileDetail[]>([]);
  const [versions, setVersions] = useState<ResearchLabProfileVersionRecord[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<EditorTab>("profile");
  const [profileDraft, setProfileDraft] = useState({
    slug: "",
    name: "",
    description: "",
  });
  const [versionDraft, setVersionDraft] = useState({
    label: "Default",
    modelFamily: "claude-sonnet-4-6",
    systemPrompt: "",
    schemaVersion: "v1",
    evidenceConfigJson: prettyJson(DEFAULT_EVIDENCE_CONFIG, DEFAULT_EVIDENCE_CONFIG),
    synthesisConfigJson: prettyJson(DEFAULT_SYNTHESIS_CONFIG, DEFAULT_SYNTHESIS_CONFIG),
    modulesConfigJson: prettyJson(DEFAULT_MODULES_CONFIG, DEFAULT_MODULES_CONFIG),
    activate: true,
  });

  const load = async (preferredProfileId?: string | null) => {
    try {
      const payload = await getAdminResearchLabProfiles();
      setProfiles(payload.profiles ?? []);
      setVersions(payload.versions ?? []);
      const nextProfileId = preferredProfileId ?? selectedProfileId ?? payload.profiles?.[0]?.id ?? null;
      setSelectedProfileId(nextProfileId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load research-lab admin data.");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  );

  useEffect(() => {
    const currentVersion = selectedProfile?.currentVersion;
    if (!currentVersion) return;
    setVersionDraft((current) => ({
      ...current,
      label: `${currentVersion.label} copy`,
      modelFamily: currentVersion.modelFamily,
      systemPrompt: currentVersion.systemPrompt,
      schemaVersion: currentVersion.schemaVersion,
      evidenceConfigJson: prettyJson(currentVersion.evidenceConfigJson, DEFAULT_EVIDENCE_CONFIG),
      synthesisConfigJson: prettyJson(currentVersion.synthesisConfigJson, DEFAULT_SYNTHESIS_CONFIG),
      modulesConfigJson: prettyJson(currentVersion.modulesConfigJson, DEFAULT_MODULES_CONFIG),
    }));
  }, [selectedProfile?.currentVersion?.id]);

  const parsedEvidenceConfig = useMemo(() => {
    try {
      return { value: JSON.parse(versionDraft.evidenceConfigJson), error: null as string | null };
    } catch (error) {
      return { value: null, error: error instanceof Error ? error.message : "Invalid JSON." };
    }
  }, [versionDraft.evidenceConfigJson]);

  const parsedSynthesisConfig = useMemo(() => {
    try {
      return { value: JSON.parse(versionDraft.synthesisConfigJson), error: null as string | null };
    } catch (error) {
      return { value: null, error: error instanceof Error ? error.message : "Invalid JSON." };
    }
  }, [versionDraft.synthesisConfigJson]);

  const parsedModulesConfig = useMemo(() => {
    try {
      return { value: JSON.parse(versionDraft.modulesConfigJson), error: null as string | null };
    } catch (error) {
      return { value: null, error: error instanceof Error ? error.message : "Invalid JSON." };
    }
  }, [versionDraft.modulesConfigJson]);

  const versionDraftHasErrors = Boolean(parsedEvidenceConfig.error || parsedSynthesisConfig.error || parsedModulesConfig.error);

  return (
    <section className="space-y-6">
      <AdminPageHeader
        eyebrow="Admin"
        title="AI Research"
        description="Manage research profiles, tune draft prompts and configs, and create explicit profile versions with inline JSON validation."
        actions={(
          <button
            className="rounded-2xl border border-borderSoft/80 bg-panelSoft/65 px-4 py-2 text-sm text-slate-200 transition hover:bg-panelSoft"
            onClick={() => void load(selectedProfileId)}
            type="button"
          >
            Refresh Workspace
          </button>
        )}
      />

      {message ? <InlineAlert tone="info">{message}</InlineAlert> : null}
      {versionDraftHasErrors ? (
        <InlineAlert tone="warning" title="JSON validation">
          Fix the highlighted config JSON before creating a new profile version.
        </InlineAlert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminStatCard label="Profiles" value={profiles.length} helper="Available AI research profiles." />
        <AdminStatCard label="Versions" value={versions.filter((version) => !selectedProfileId || version.profileId === selectedProfileId).length} helper="Stored versions for the current scope." />
        <AdminStatCard label="Default Profile" value={profiles.find((profile) => profile.isDefault)?.name ?? "none"} helper="Current default research profile." tone={profiles.some((profile) => profile.isDefault) ? "success" : "info"} />
        <AdminStatCard label="Draft Status" value={versionDraftHasErrors ? "invalid" : "ready"} helper={selectedProfile ? "Version draft for the selected profile." : "Select a profile to draft a version."} tone={versionDraftHasErrors ? "warning" : "success"} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[18rem,minmax(0,1fr)]">
        <div className="space-y-4">
          <AdminCard title="Research Profiles" description="Select a profile to inspect its current version and draft the next one.">
            <div className="space-y-2">
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  className={`w-full rounded border px-3 py-2 text-left ${profile.id === selectedProfileId ? "border-accent/60 bg-accent/10" : "border-borderSoft/60 hover:bg-slate-900/30"}`}
                  onClick={() => setSelectedProfileId(profile.id)}
                  type="button"
                >
                  <div className="text-sm font-semibold text-accent">{profile.name}</div>
                  <div className="text-[11px] text-slate-400">
                    v{profile.currentVersion?.versionNumber ?? "-"} {profile.isDefault ? "· default" : ""}
                  </div>
                </button>
              ))}
              {profiles.length === 0 ? <EmptyState title="No research profiles yet" description="Create the first profile to start versioning prompts and configs." /> : null}
            </div>
          </AdminCard>

          <AdminCard title="New Profile" description="Create a new research profile shell before drafting a version.">
            <div className="space-y-2">
              <input
                className="w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                placeholder="Slug"
                value={profileDraft.slug}
                onChange={(event) => setProfileDraft((current) => ({ ...current, slug: event.target.value }))}
              />
              <input
                className="w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                placeholder="Name"
                value={profileDraft.name}
                onChange={(event) => setProfileDraft((current) => ({ ...current, name: event.target.value }))}
              />
              <textarea
                className="min-h-20 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                placeholder="Description"
                value={profileDraft.description}
                onChange={(event) => setProfileDraft((current) => ({ ...current, description: event.target.value }))}
              />
              <button
                className="rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-sm text-accent"
                onClick={async () => {
                  try {
                    const created = await createAdminResearchLabProfile({
                      slug: profileDraft.slug,
                      name: profileDraft.name,
                      description: profileDraft.description || null,
                    });
                    setProfileDraft({ slug: "", name: "", description: "" });
                    setMessage("Research-lab profile created.");
                    await load(created.id);
                  } catch (error) {
                    setMessage(error instanceof Error ? error.message : "Failed to create research-lab profile.");
                  }
                }}
                type="button"
              >
                Create Profile
              </button>
            </div>
          </AdminCard>
        </div>

        <div className="space-y-4">
          {selectedProfile ? (
            <AdminCard
              title={selectedProfile.name}
              description={selectedProfile.description ?? "No description"}
              actions={(
                <button
                  className="rounded-xl border border-borderSoft/80 bg-panelSoft/65 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft"
                  onClick={async () => {
                    try {
                      await updateAdminResearchLabProfile(selectedProfile.id, { isDefault: !selectedProfile.isDefault });
                      setMessage(selectedProfile.isDefault ? "Default research-lab profile cleared." : "Default research-lab profile updated.");
                      await load(selectedProfile.id);
                    } catch (error) {
                      setMessage(error instanceof Error ? error.message : "Failed to update research-lab profile.");
                    }
                  }}
                  type="button"
                >
                  {selectedProfile.isDefault ? "Unset Default" : "Make Default"}
                </button>
              )}
            >
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {EDITOR_TABS.map((tab) => (
                    <button
                      key={tab.key}
                      className={`rounded-2xl border px-4 py-2 text-sm transition ${
                        activeTab === tab.key
                          ? "border-accent/40 bg-accent/10 text-text"
                          : "border-borderSoft/70 bg-panelSoft/35 text-slate-300 hover:border-accent/20 hover:bg-panelSoft/60"
                      }`}
                      onClick={() => setActiveTab(tab.key)}
                      type="button"
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {activeTab === "profile" ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="text-xs text-slate-300">
                      Version Label
                      <input
                        className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                        value={versionDraft.label}
                        onChange={(event) => setVersionDraft((current) => ({ ...current, label: event.target.value }))}
                      />
                    </label>
                    <label className="text-xs text-slate-300">
                      Model Family
                      <input
                        className="mt-2 h-11 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 text-sm text-text"
                        value={versionDraft.modelFamily}
                        onChange={(event) => setVersionDraft((current) => ({ ...current, modelFamily: event.target.value }))}
                      />
                    </label>
                  </div>
                ) : null}

                {activeTab === "prompt" ? (
                  <label className="block text-xs text-slate-300">
                    Base System Prompt
                    <textarea
                      className="mt-2 min-h-72 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 py-3 text-sm text-text"
                      value={versionDraft.systemPrompt}
                      onChange={(event) => setVersionDraft((current) => ({ ...current, systemPrompt: event.target.value }))}
                    />
                  </label>
                ) : null}

                {activeTab === "evidence" ? (
                  <div className="space-y-3">
                    <label className="block text-xs text-slate-300">
                      Evidence Config JSON
                      <textarea
                        className="mt-2 min-h-80 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 py-3 font-mono text-xs text-text"
                        value={versionDraft.evidenceConfigJson}
                        onChange={(event) => setVersionDraft((current) => ({ ...current, evidenceConfigJson: event.target.value }))}
                      />
                    </label>
                    {parsedEvidenceConfig.error ? <InlineAlert tone="danger">{parsedEvidenceConfig.error}</InlineAlert> : null}
                  </div>
                ) : null}

                {activeTab === "synthesis" ? (
                  <div className="space-y-3">
                    <label className="block text-xs text-slate-300">
                      Synthesis Config JSON
                      <textarea
                        className="mt-2 min-h-80 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 py-3 font-mono text-xs text-text"
                        value={versionDraft.synthesisConfigJson}
                        onChange={(event) => setVersionDraft((current) => ({ ...current, synthesisConfigJson: event.target.value }))}
                      />
                    </label>
                    {parsedSynthesisConfig.error ? <InlineAlert tone="danger">{parsedSynthesisConfig.error}</InlineAlert> : null}
                  </div>
                ) : null}

                {activeTab === "modules" ? (
                  <div className="space-y-3">
                    <label className="block text-xs text-slate-300">
                      Modules Config JSON
                      <textarea
                        className="mt-2 min-h-80 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 py-3 font-mono text-xs text-text"
                        value={versionDraft.modulesConfigJson}
                        onChange={(event) => setVersionDraft((current) => ({ ...current, modulesConfigJson: event.target.value }))}
                      />
                    </label>
                    {parsedModulesConfig.error ? <InlineAlert tone="danger">{parsedModulesConfig.error}</InlineAlert> : null}
                    <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/35 p-4 text-xs text-slate-400">
                      <div className="font-semibold text-slate-300">Example module config</div>
                      <div className="mt-2 font-mono">
                        {`{\n  "keyDrivers": {\n    "enabled": true,\n    "maxDrivers": 3,\n    "requirePriceRelationship": true,\n    "priceWindow": "90d"\n  }\n}`}
                      </div>
                    </div>
                  </div>
                ) : null}

                {activeTab === "versions" ? (
                  <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/35 p-4 text-sm text-slate-300">
                    Current version: v{selectedProfile.currentVersion?.versionNumber ?? "-"} | {selectedProfile.currentVersion?.label ?? "none"}
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-3 border-t border-borderSoft/70 pt-4">
                  <label className="flex items-center gap-2 text-sm text-slate-300">
                    <input
                      type="checkbox"
                      checked={versionDraft.activate}
                      onChange={(event) => setVersionDraft((current) => ({ ...current, activate: event.target.checked }))}
                    />
                    Activate immediately
                  </label>
                  <button
                    className="rounded-2xl bg-accent px-4 py-2 text-sm font-medium text-slate-950 transition hover:brightness-110 disabled:opacity-60"
                    disabled={versionDraftHasErrors}
                    onClick={async () => {
                      try {
                        await createAdminResearchLabProfileVersion(selectedProfile.id, {
                          label: versionDraft.label,
                          modelFamily: versionDraft.modelFamily,
                          systemPrompt: versionDraft.systemPrompt,
                          schemaVersion: versionDraft.schemaVersion,
                          evidenceConfigJson: parsedEvidenceConfig.value,
                          synthesisConfigJson: parsedSynthesisConfig.value,
                          modulesConfigJson: parsedModulesConfig.value,
                          activate: versionDraft.activate,
                        });
                        setMessage("Research-lab profile version created.");
                        await load(selectedProfile.id);
                        setActiveTab("versions");
                      } catch (error) {
                        setMessage(error instanceof Error ? error.message : "Failed to create research-lab profile version.");
                      }
                    }}
                    type="button"
                  >
                    Create Version
                  </button>
                </div>
              </div>
            </AdminCard>
          ) : (
            <EmptyState title="No profile selected" description="Choose a profile from the left or create a new one to start drafting research versions." />
          )}

          <AdminCard title="Stored Versions" description="Review the saved versions for the selected profile or across all profiles.">
            <div className="space-y-2">
              {versions
                .filter((version) => !selectedProfileId || version.profileId === selectedProfileId)
                .map((version) => (
                  <div key={version.id} className="rounded border border-borderSoft/60 bg-panelSoft/35 p-3 text-sm text-slate-300">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-semibold text-accent">{version.label}</div>
                      <div className="text-[11px] text-slate-500">v{version.versionNumber}</div>
                    </div>
                    <div className="mt-1 text-xs text-slate-400">{version.modelFamily}</div>
                    <div className="mt-2 text-xs text-slate-500">
                      Modules: {Object.keys(version.modulesConfigJson ?? {}).length > 0 ? Object.keys(version.modulesConfigJson ?? {}).join(", ") : "none"}
                    </div>
                  </div>
                ))}
              {versions.filter((version) => !selectedProfileId || version.profileId === selectedProfileId).length === 0 ? (
                <EmptyState title="No stored versions yet" description="Create the first version for this profile to see history here." />
              ) : null}
            </div>
          </AdminCard>
        </div>
      </div>
    </section>
  );
}
