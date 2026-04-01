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

export function ResearchLabAdminPanel() {
  const [profiles, setProfiles] = useState<ResearchLabProfileDetail[]>([]);
  const [versions, setVersions] = useState<ResearchLabProfileVersionRecord[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
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

  return (
    <section className="space-y-4">
      {message ? (
        <div className="card border border-borderSoft/70 p-3 text-sm text-slate-300">{message}</div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[18rem,minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="card p-3">
            <div className="mb-3 text-sm font-semibold text-slate-200">Research Lab Profiles</div>
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
              {profiles.length === 0 ? <p className="text-xs text-slate-400">No research-lab profiles found.</p> : null}
            </div>
          </div>

          <div className="card p-3">
            <div className="mb-2 text-sm font-semibold text-slate-200">New Profile</div>
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
          </div>
        </div>

        <div className="space-y-4">
          {selectedProfile ? (
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
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-xs text-slate-300">
                  Version Label
                  <input
                    className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm"
                    value={versionDraft.label}
                    onChange={(event) => setVersionDraft((current) => ({ ...current, label: event.target.value }))}
                  />
                </label>
                <label className="text-xs text-slate-300">
                  Model Family
                  <input
                    className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm"
                    value={versionDraft.modelFamily}
                    onChange={(event) => setVersionDraft((current) => ({ ...current, modelFamily: event.target.value }))}
                  />
                </label>
              </div>

              <label className="mt-3 block text-xs text-slate-300">
                Base System Prompt
                <textarea
                  className="mt-1 min-h-40 w-full rounded border border-borderSoft bg-panelSoft px-3 py-2 text-sm"
                  value={versionDraft.systemPrompt}
                  onChange={(event) => setVersionDraft((current) => ({ ...current, systemPrompt: event.target.value }))}
                />
              </label>

              <div className="mt-4 grid gap-4 xl:grid-cols-3">
                <label className="text-xs text-slate-300">
                  Evidence Config JSON
                  <textarea
                    className="mt-1 min-h-72 w-full rounded border border-borderSoft bg-panelSoft px-3 py-2 font-mono text-xs"
                    value={versionDraft.evidenceConfigJson}
                    onChange={(event) => setVersionDraft((current) => ({ ...current, evidenceConfigJson: event.target.value }))}
                  />
                </label>
                <label className="text-xs text-slate-300">
                  Synthesis Config JSON
                  <textarea
                    className="mt-1 min-h-72 w-full rounded border border-borderSoft bg-panelSoft px-3 py-2 font-mono text-xs"
                    value={versionDraft.synthesisConfigJson}
                    onChange={(event) => setVersionDraft((current) => ({ ...current, synthesisConfigJson: event.target.value }))}
                  />
                </label>
                <label className="text-xs text-slate-300">
                  Modules Config JSON
                  <textarea
                    className="mt-1 min-h-72 w-full rounded border border-borderSoft bg-panelSoft px-3 py-2 font-mono text-xs"
                    value={versionDraft.modulesConfigJson}
                    onChange={(event) => setVersionDraft((current) => ({ ...current, modulesConfigJson: event.target.value }))}
                  />
                </label>
              </div>

              <div className="mt-3 rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-3 text-xs text-slate-400">
                <div className="font-semibold text-slate-300">Example module config</div>
                <div className="mt-2 font-mono">
                  {`{\n  "keyDrivers": {\n    "enabled": true,\n    "maxDrivers": 3,\n    "requirePriceRelationship": true,\n    "priceWindow": "90d"\n  }\n}`}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={versionDraft.activate}
                    onChange={(event) => setVersionDraft((current) => ({ ...current, activate: event.target.checked }))}
                  />
                  Activate immediately
                </label>
                <button
                  className="rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-sm text-accent"
                  onClick={async () => {
                    try {
                      await createAdminResearchLabProfileVersion(selectedProfile.id, {
                        label: versionDraft.label,
                        modelFamily: versionDraft.modelFamily,
                        systemPrompt: versionDraft.systemPrompt,
                        schemaVersion: versionDraft.schemaVersion,
                        evidenceConfigJson: JSON.parse(versionDraft.evidenceConfigJson),
                        synthesisConfigJson: JSON.parse(versionDraft.synthesisConfigJson),
                        modulesConfigJson: JSON.parse(versionDraft.modulesConfigJson),
                        activate: versionDraft.activate,
                      });
                      setMessage("Research-lab profile version created.");
                      await load(selectedProfile.id);
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
          ) : null}

          <div className="card p-4">
            <div className="mb-3 text-sm font-semibold text-slate-200">Stored Versions</div>
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
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
