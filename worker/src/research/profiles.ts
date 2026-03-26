import type { Env } from "../types";
import { DEFAULT_RESEARCH_PROFILE_ID, DEFAULT_RESEARCH_SETTINGS } from "./constants";
import type {
  PromptVersionRecord,
  ResearchAdminVersionsResponse,
  ResearchProfileDetail,
  ResearchProfileRecord,
  ResearchProfileSettings,
  ResearchProfileVersionRecord,
  ResolvedResearchProfile,
  RubricVersionRecord,
  SearchTemplateVersionRecord,
} from "./types";
import { normalizeResearchProfileSettings } from "./validation";

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function uid() {
  return crypto.randomUUID();
}

function mapPromptVersion(row: any): PromptVersionRecord {
  return {
    id: String(row.id),
    promptKind: row.promptKind,
    versionNumber: Number(row.versionNumber ?? 0),
    label: String(row.label ?? ""),
    providerKey: String(row.providerKey ?? ""),
    modelFamily: String(row.modelFamily ?? ""),
    schemaVersion: String(row.schemaVersion ?? "v1"),
    templateText: row.templateText ?? null,
    templateJson: parseJson<Record<string, unknown> | null>(row.templateJson, null),
    isActive: Boolean(row.isActive),
    createdAt: String(row.createdAt ?? ""),
  };
}

function mapRubricVersion(row: any): RubricVersionRecord {
  return {
    id: String(row.id),
    versionNumber: Number(row.versionNumber ?? 0),
    label: String(row.label ?? ""),
    schemaVersion: String(row.schemaVersion ?? "v1"),
    rubricJson: parseJson<Record<string, unknown>>(row.rubricJson, {}),
    createdAt: String(row.createdAt ?? ""),
  };
}

function mapSearchTemplateVersion(row: any): SearchTemplateVersionRecord {
  return {
    id: String(row.id),
    versionNumber: Number(row.versionNumber ?? 0),
    label: String(row.label ?? ""),
    schemaVersion: String(row.schemaVersion ?? "v1"),
    templateJson: parseJson<Record<string, unknown>>(row.templateJson, {}),
    createdAt: String(row.createdAt ?? ""),
  };
}

function mapProfileRecord(row: any): ResearchProfileRecord {
  return {
    id: String(row.id),
    slug: String(row.slug ?? ""),
    name: String(row.name ?? ""),
    description: row.description ?? null,
    isActive: Boolean(row.isActive),
    isDefault: Boolean(row.isDefault),
    currentVersionId: row.currentVersionId ?? null,
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? ""),
  };
}

function mapProfileVersionRecord(row: any): ResearchProfileVersionRecord {
  const rawSettings = parseJson<Partial<ResearchProfileSettings>>(row.settingsJson, {});
  return {
    id: String(row.id),
    profileId: String(row.profileId),
    versionNumber: Number(row.versionNumber ?? 0),
    promptVersionIdHaiku: String(row.promptVersionIdHaiku),
    promptVersionIdSonnetRank: String(row.promptVersionIdSonnetRank),
    promptVersionIdSonnetDeepDive: String(row.promptVersionIdSonnetDeepDive),
    rubricVersionId: String(row.rubricVersionId),
    searchTemplateVersionId: String(row.searchTemplateVersionId),
    settings: normalizeResearchProfileSettings({
      ...DEFAULT_RESEARCH_SETTINGS,
      ...rawSettings,
      peerComparisonEnabled: rawSettings.peerComparisonEnabled ?? rawSettings.comparisonEnabled ?? DEFAULT_RESEARCH_SETTINGS.peerComparisonEnabled,
      sourceFamilies: {
        ...DEFAULT_RESEARCH_SETTINGS.sourceFamilies,
        ...(rawSettings.sourceFamilies ?? {}),
      },
    }),
    isActive: Boolean(row.isActive),
    createdAt: String(row.createdAt ?? ""),
  };
}

export async function listResearchProfiles(env: Env): Promise<ResearchProfileDetail[]> {
  const profilesRes = await env.DB.prepare(
    "SELECT id, slug, name, description, is_active as isActive, is_default as isDefault, current_version_id as currentVersionId, created_at as createdAt, updated_at as updatedAt FROM research_profiles ORDER BY is_default DESC, name ASC",
  ).all();
  const versionsRes = await env.DB.prepare(
    "SELECT id, profile_id as profileId, version_number as versionNumber, prompt_version_id_haiku as promptVersionIdHaiku, prompt_version_id_sonnet_rank as promptVersionIdSonnetRank, prompt_version_id_sonnet_deep_dive as promptVersionIdSonnetDeepDive, rubric_version_id as rubricVersionId, search_template_version_id as searchTemplateVersionId, settings_json as settingsJson, is_active as isActive, created_at as createdAt FROM research_profile_versions ORDER BY profile_id ASC, version_number DESC",
  ).all();
  const versionMap = new Map<string, ResearchProfileVersionRecord>(
    (versionsRes.results ?? []).map((row: any) => {
      const mapped = mapProfileVersionRecord(row);
      return [mapped.id, mapped];
    }),
  );
  return (profilesRes.results ?? []).map((row: any) => {
    const profile = mapProfileRecord(row);
    return {
      ...profile,
      currentVersion: profile.currentVersionId ? versionMap.get(profile.currentVersionId) ?? null : null,
    };
  });
}

export async function listResearchAdminVersions(env: Env): Promise<ResearchAdminVersionsResponse> {
  const [profiles, promptRows, rubricRows, searchRows] = await Promise.all([
    listResearchProfiles(env),
    env.DB.prepare(
      "SELECT id, prompt_kind as promptKind, version_number as versionNumber, label, provider_key as providerKey, model_family as modelFamily, schema_version as schemaVersion, template_text as templateText, template_json as templateJson, is_active as isActive, created_at as createdAt FROM prompt_versions ORDER BY prompt_kind ASC, version_number DESC",
    ).all(),
    env.DB.prepare(
      "SELECT id, version_number as versionNumber, label, schema_version as schemaVersion, rubric_json as rubricJson, created_at as createdAt FROM rubric_versions ORDER BY version_number DESC",
    ).all(),
    env.DB.prepare(
      "SELECT id, version_number as versionNumber, label, schema_version as schemaVersion, template_json as templateJson, created_at as createdAt FROM search_template_versions ORDER BY version_number DESC",
    ).all(),
  ]);
  return {
    profiles,
    promptVersions: (promptRows.results ?? []).map(mapPromptVersion),
    rubricVersions: (rubricRows.results ?? []).map(mapRubricVersion),
    searchTemplateVersions: (searchRows.results ?? []).map(mapSearchTemplateVersion),
  };
}

export async function resolveResearchProfile(env: Env, profileId?: string | null): Promise<ResolvedResearchProfile> {
  const targetId = profileId?.trim() || DEFAULT_RESEARCH_PROFILE_ID;
  const profileRow = await env.DB.prepare(
    "SELECT id, slug, name, description, is_active as isActive, is_default as isDefault, current_version_id as currentVersionId, created_at as createdAt, updated_at as updatedAt FROM research_profiles WHERE id = ? LIMIT 1",
  ).bind(targetId).first();
  const fallbackProfileRow = !profileRow
    ? await env.DB.prepare(
      "SELECT id, slug, name, description, is_active as isActive, is_default as isDefault, current_version_id as currentVersionId, created_at as createdAt, updated_at as updatedAt FROM research_profiles WHERE is_default = 1 ORDER BY updated_at DESC LIMIT 1",
    ).first()
    : null;
  const profile = mapProfileRecord(profileRow ?? fallbackProfileRow);
  if (!profile.currentVersionId) throw new Error(`Research profile ${profile.id} has no active version.`);
  const versionRow = await env.DB.prepare(
    "SELECT id, profile_id as profileId, version_number as versionNumber, prompt_version_id_haiku as promptVersionIdHaiku, prompt_version_id_sonnet_rank as promptVersionIdSonnetRank, prompt_version_id_sonnet_deep_dive as promptVersionIdSonnetDeepDive, rubric_version_id as rubricVersionId, search_template_version_id as searchTemplateVersionId, settings_json as settingsJson, is_active as isActive, created_at as createdAt FROM research_profile_versions WHERE id = ? LIMIT 1",
  ).bind(profile.currentVersionId).first();
  if (!versionRow) throw new Error(`Research profile version ${profile.currentVersionId} not found.`);
  const version = mapProfileVersionRecord(versionRow);
  const [haikuRow, rankRow, deepDiveRow, rubricRow, searchRow] = await Promise.all([
    env.DB.prepare("SELECT id, prompt_kind as promptKind, version_number as versionNumber, label, provider_key as providerKey, model_family as modelFamily, schema_version as schemaVersion, template_text as templateText, template_json as templateJson, is_active as isActive, created_at as createdAt FROM prompt_versions WHERE id = ? LIMIT 1").bind(version.promptVersionIdHaiku).first(),
    env.DB.prepare("SELECT id, prompt_kind as promptKind, version_number as versionNumber, label, provider_key as providerKey, model_family as modelFamily, schema_version as schemaVersion, template_text as templateText, template_json as templateJson, is_active as isActive, created_at as createdAt FROM prompt_versions WHERE id = ? LIMIT 1").bind(version.promptVersionIdSonnetRank).first(),
    env.DB.prepare("SELECT id, prompt_kind as promptKind, version_number as versionNumber, label, provider_key as providerKey, model_family as modelFamily, schema_version as schemaVersion, template_text as templateText, template_json as templateJson, is_active as isActive, created_at as createdAt FROM prompt_versions WHERE id = ? LIMIT 1").bind(version.promptVersionIdSonnetDeepDive).first(),
    env.DB.prepare("SELECT id, version_number as versionNumber, label, schema_version as schemaVersion, rubric_json as rubricJson, created_at as createdAt FROM rubric_versions WHERE id = ? LIMIT 1").bind(version.rubricVersionId).first(),
    env.DB.prepare("SELECT id, version_number as versionNumber, label, schema_version as schemaVersion, template_json as templateJson, created_at as createdAt FROM search_template_versions WHERE id = ? LIMIT 1").bind(version.searchTemplateVersionId).first(),
  ]);
  if (!haikuRow || !rankRow || !deepDiveRow || !rubricRow || !searchRow) {
    throw new Error(`Research profile ${profile.name} references a missing version dependency.`);
  }
  return {
    profile,
    version,
    bundle: {
      haiku: mapPromptVersion(haikuRow),
      sonnetRank: mapPromptVersion(rankRow),
      sonnetDeepDive: mapPromptVersion(deepDiveRow),
      rubric: mapRubricVersion(rubricRow),
      searchTemplate: mapSearchTemplateVersion(searchRow),
    },
  };
}

export async function createResearchProfile(env: Env, payload: {
  slug: string;
  name: string;
  description?: string | null;
  isActive?: boolean;
  isDefault?: boolean;
}): Promise<{ id: string }> {
  const id = uid();
  const statements = [];
  if (payload.isDefault) {
    statements.push(env.DB.prepare("UPDATE research_profiles SET is_default = 0 WHERE is_default = 1"));
  }
  statements.push(
    env.DB.prepare(
      "INSERT INTO research_profiles (id, slug, name, description, is_active, is_default, current_version_id) VALUES (?, ?, ?, ?, ?, ?, NULL)",
    ).bind(id, payload.slug, payload.name, payload.description ?? null, payload.isActive === false ? 0 : 1, payload.isDefault ? 1 : 0),
  );
  await env.DB.batch(statements);
  return { id };
}

export async function updateResearchProfile(env: Env, profileId: string, payload: {
  slug?: string;
  name?: string;
  description?: string | null;
  isActive?: boolean;
  isDefault?: boolean;
  currentVersionId?: string | null;
}): Promise<void> {
  const current = await env.DB.prepare(
    "SELECT id, slug, name, description, is_active as isActive, is_default as isDefault, current_version_id as currentVersionId FROM research_profiles WHERE id = ? LIMIT 1",
  ).bind(profileId).first();
  if (!current) throw new Error("Research profile not found.");
  const next = {
    slug: payload.slug ?? current.slug,
    name: payload.name ?? current.name,
    description: payload.description === undefined ? current.description : payload.description,
    isActive: payload.isActive === undefined ? Boolean(current.isActive) : payload.isActive,
    isDefault: payload.isDefault === undefined ? Boolean(current.isDefault) : payload.isDefault,
    currentVersionId: payload.currentVersionId === undefined ? current.currentVersionId : payload.currentVersionId,
  };
  const statements = [];
  if (next.isDefault) {
    statements.push(env.DB.prepare("UPDATE research_profiles SET is_default = 0 WHERE is_default = 1 AND id <> ?").bind(profileId));
  }
  statements.push(
    env.DB.prepare(
      "UPDATE research_profiles SET slug = ?, name = ?, description = ?, is_active = ?, is_default = ?, current_version_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).bind(next.slug, next.name, next.description ?? null, next.isActive ? 1 : 0, next.isDefault ? 1 : 0, next.currentVersionId ?? null, profileId),
  );
  await env.DB.batch(statements);
}

export async function createResearchProfileVersion(env: Env, profileId: string, payload: {
  promptVersionIdHaiku: string;
  promptVersionIdSonnetRank: string;
  promptVersionIdSonnetDeepDive: string;
  rubricVersionId: string;
  searchTemplateVersionId: string;
  settings: ResearchProfileSettings;
  activate?: boolean;
}): Promise<{ id: string; versionNumber: number }> {
  const current = await env.DB.prepare(
    "SELECT COALESCE(MAX(version_number), 0) as maxVersion FROM research_profile_versions WHERE profile_id = ?",
  ).bind(profileId).first<{ maxVersion: number | null }>();
  const versionNumber = (current?.maxVersion ?? 0) + 1;
  const id = uid();
  await env.DB.prepare(
    "INSERT INTO research_profile_versions (id, profile_id, version_number, prompt_version_id_haiku, prompt_version_id_sonnet_rank, prompt_version_id_sonnet_deep_dive, rubric_version_id, search_template_version_id, settings_json, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
  ).bind(
    id,
    profileId,
    versionNumber,
    payload.promptVersionIdHaiku,
    payload.promptVersionIdSonnetRank,
    payload.promptVersionIdSonnetDeepDive,
    payload.rubricVersionId,
    payload.searchTemplateVersionId,
    JSON.stringify(payload.settings),
  ).run();
  if (payload.activate !== false) {
    await updateResearchProfile(env, profileId, { currentVersionId: id });
  }
  return { id, versionNumber };
}

export async function createPromptVersion(env: Env, payload: {
  promptKind: "haiku_extract" | "sonnet_rank" | "sonnet_deep_dive";
  label: string;
  providerKey: string;
  modelFamily: string;
  schemaVersion: string;
  templateText?: string | null;
  templateJson?: Record<string, unknown> | null;
}): Promise<{ id: string }> {
  const latest = await env.DB.prepare(
    "SELECT COALESCE(MAX(version_number), 0) as maxVersion FROM prompt_versions WHERE prompt_kind = ?",
  ).bind(payload.promptKind).first<{ maxVersion: number | null }>();
  const id = uid();
  await env.DB.prepare(
    "INSERT INTO prompt_versions (id, prompt_kind, version_number, label, provider_key, model_family, schema_version, template_text, template_json, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
  ).bind(
    id,
    payload.promptKind,
    (latest?.maxVersion ?? 0) + 1,
    payload.label,
    payload.providerKey,
    payload.modelFamily,
    payload.schemaVersion,
    payload.templateText ?? null,
    payload.templateJson ? JSON.stringify(payload.templateJson) : null,
  ).run();
  return { id };
}

export async function createRubricVersion(env: Env, payload: {
  label: string;
  schemaVersion: string;
  rubricJson: Record<string, unknown>;
}): Promise<{ id: string }> {
  const latest = await env.DB.prepare(
    "SELECT COALESCE(MAX(version_number), 0) as maxVersion FROM rubric_versions",
  ).first<{ maxVersion: number | null }>();
  const id = uid();
  await env.DB.prepare(
    "INSERT INTO rubric_versions (id, version_number, label, schema_version, rubric_json) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, (latest?.maxVersion ?? 0) + 1, payload.label, payload.schemaVersion, JSON.stringify(payload.rubricJson)).run();
  return { id };
}

export async function createSearchTemplateVersion(env: Env, payload: {
  label: string;
  schemaVersion: string;
  templateJson: Record<string, unknown>;
}): Promise<{ id: string }> {
  const latest = await env.DB.prepare(
    "SELECT COALESCE(MAX(version_number), 0) as maxVersion FROM search_template_versions",
  ).first<{ maxVersion: number | null }>();
  const id = uid();
  await env.DB.prepare(
    "INSERT INTO search_template_versions (id, version_number, label, schema_version, template_json) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, (latest?.maxVersion ?? 0) + 1, payload.label, payload.schemaVersion, JSON.stringify(payload.templateJson)).run();
  return { id };
}
