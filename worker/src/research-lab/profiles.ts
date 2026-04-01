import type { Env } from "../types";
import type {
  ResearchLabAdminProfilesResponse,
  ResearchLabEvidenceProfileRecord,
  ResearchLabProfileDetail,
  ResearchLabProfileRecord,
  ResearchLabProfileVersionRecord,
  ResearchLabPromptConfigRecord,
  ResearchLabResolvedProfile,
} from "./types";

function uid() {
  return crypto.randomUUID();
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapProfile(row: any): ResearchLabProfileRecord {
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

function mapVersion(row: any): ResearchLabProfileVersionRecord {
  return {
    id: String(row.id),
    profileId: String(row.profileId),
    versionNumber: Number(row.versionNumber ?? 0),
    label: String(row.label ?? ""),
    modelFamily: String(row.modelFamily ?? ""),
    systemPrompt: String(row.systemPrompt ?? ""),
    schemaVersion: String(row.schemaVersion ?? "v1"),
    evidenceConfigJson: parseJson(row.evidenceConfigJson, {}),
    synthesisConfigJson: parseJson(row.synthesisConfigJson, {}),
    modulesConfigJson: parseJson(row.modulesConfigJson, {}),
    isActive: Boolean(row.isActive),
    createdAt: String(row.createdAt ?? ""),
  };
}

function buildPromptConfig(profile: ResearchLabProfileRecord, version: ResearchLabProfileVersionRecord): ResearchLabPromptConfigRecord {
  return {
    id: version.id,
    name: `${profile.name} (${version.label})`,
    description: profile.description,
    configFamily: `profile:${profile.id}`,
    modelFamily: version.modelFamily,
    systemPrompt: version.systemPrompt,
    schemaVersion: version.schemaVersion,
    isDefault: profile.isDefault,
    synthesisConfigJson: {
      ...(version.synthesisConfigJson ?? {}),
      modules: version.modulesConfigJson ?? {},
    },
    profileId: profile.id,
    profileVersionId: version.id,
    createdAt: version.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function buildEvidenceProfile(profile: ResearchLabProfileRecord, version: ResearchLabProfileVersionRecord): ResearchLabEvidenceProfileRecord {
  return {
    id: version.id,
    name: `${profile.name} Evidence (${version.label})`,
    description: profile.description,
    configFamily: `profile:${profile.id}`,
    isDefault: profile.isDefault,
    queryConfigJson: version.evidenceConfigJson ?? {},
    createdAt: version.createdAt,
    updatedAt: profile.updatedAt,
  };
}

export function createResearchLabPromptConfigFromProfile(
  profile: ResearchLabProfileRecord,
  version: ResearchLabProfileVersionRecord,
): ResearchLabPromptConfigRecord {
  return buildPromptConfig(profile, version);
}

export function createResearchLabEvidenceProfileFromProfile(
  profile: ResearchLabProfileRecord,
  version: ResearchLabProfileVersionRecord,
): ResearchLabEvidenceProfileRecord {
  return buildEvidenceProfile(profile, version);
}

export async function listResearchLabProfiles(env: Env): Promise<ResearchLabProfileDetail[]> {
  const [profilesRes, versionsRes] = await Promise.all([
    env.DB.prepare(
      "SELECT id, slug, name, description, is_active as isActive, is_default as isDefault, current_version_id as currentVersionId, created_at as createdAt, updated_at as updatedAt FROM research_lab_profiles ORDER BY is_default DESC, name ASC",
    ).all(),
    env.DB.prepare(
      "SELECT id, profile_id as profileId, version_number as versionNumber, label, model_family as modelFamily, system_prompt as systemPrompt, schema_version as schemaVersion, evidence_config_json as evidenceConfigJson, synthesis_config_json as synthesisConfigJson, modules_config_json as modulesConfigJson, is_active as isActive, created_at as createdAt FROM research_lab_profile_versions ORDER BY profile_id ASC, version_number DESC",
    ).all(),
  ]);
  const versionMap = new Map<string, ResearchLabProfileVersionRecord>(
    (versionsRes.results ?? []).map((row: any) => {
      const mapped = mapVersion(row);
      return [mapped.id, mapped];
    }),
  );
  return (profilesRes.results ?? []).map((row: any) => {
    const profile = mapProfile(row);
    return {
      ...profile,
      currentVersion: profile.currentVersionId ? versionMap.get(profile.currentVersionId) ?? null : null,
    };
  });
}

export async function listResearchLabAdminProfiles(env: Env): Promise<ResearchLabAdminProfilesResponse> {
  const [profiles, versionsRes] = await Promise.all([
    listResearchLabProfiles(env),
    env.DB.prepare(
      "SELECT id, profile_id as profileId, version_number as versionNumber, label, model_family as modelFamily, system_prompt as systemPrompt, schema_version as schemaVersion, evidence_config_json as evidenceConfigJson, synthesis_config_json as synthesisConfigJson, modules_config_json as modulesConfigJson, is_active as isActive, created_at as createdAt FROM research_lab_profile_versions ORDER BY profile_id ASC, version_number DESC",
    ).all(),
  ]);
  return {
    profiles,
    versions: (versionsRes.results ?? []).map((row: any) => mapVersion(row)),
  };
}

export async function loadResearchLabProfile(env: Env, profileId: string): Promise<ResearchLabProfileRecord | null> {
  const row = await env.DB.prepare(
    "SELECT id, slug, name, description, is_active as isActive, is_default as isDefault, current_version_id as currentVersionId, created_at as createdAt, updated_at as updatedAt FROM research_lab_profiles WHERE id = ? LIMIT 1",
  ).bind(profileId).first();
  return row ? mapProfile(row) : null;
}

export async function loadResearchLabProfileVersion(env: Env, versionId: string): Promise<ResearchLabProfileVersionRecord | null> {
  const row = await env.DB.prepare(
    "SELECT id, profile_id as profileId, version_number as versionNumber, label, model_family as modelFamily, system_prompt as systemPrompt, schema_version as schemaVersion, evidence_config_json as evidenceConfigJson, synthesis_config_json as synthesisConfigJson, modules_config_json as modulesConfigJson, is_active as isActive, created_at as createdAt FROM research_lab_profile_versions WHERE id = ? LIMIT 1",
  ).bind(versionId).first();
  return row ? mapVersion(row) : null;
}

export async function resolveResearchLabProfileAtVersion(
  env: Env,
  profileId: string,
  versionId: string,
): Promise<ResearchLabResolvedProfile> {
  const [profile, version] = await Promise.all([
    loadResearchLabProfile(env, profileId),
    loadResearchLabProfileVersion(env, versionId),
  ]);
  if (!profile) {
    throw new Error(`Research-lab profile ${profileId} was not found.`);
  }
  if (!version || version.profileId !== profile.id) {
    throw new Error(`Research-lab profile version ${versionId} was not found for profile ${profile.name}.`);
  }
  return {
    profile,
    version,
    promptConfig: buildPromptConfig(profile, version),
    evidenceProfile: buildEvidenceProfile(profile, version),
  };
}

export async function resolveResearchLabProfile(env: Env, profileId?: string | null): Promise<ResearchLabResolvedProfile> {
  const explicitProfile = profileId?.trim()
    ? await env.DB.prepare(
      "SELECT id, slug, name, description, is_active as isActive, is_default as isDefault, current_version_id as currentVersionId, created_at as createdAt, updated_at as updatedAt FROM research_lab_profiles WHERE id = ? LIMIT 1",
    ).bind(profileId.trim()).first()
    : null;
  const fallbackProfile = !explicitProfile
    ? await env.DB.prepare(
      "SELECT id, slug, name, description, is_active as isActive, is_default as isDefault, current_version_id as currentVersionId, created_at as createdAt, updated_at as updatedAt FROM research_lab_profiles WHERE is_default = 1 ORDER BY updated_at DESC LIMIT 1",
    ).first()
    : null;
  const profileRow = explicitProfile ?? fallbackProfile;
  if (!profileRow) {
    throw new Error("No research-lab profile is configured.");
  }
  const profile = mapProfile(profileRow);
  if (!profile.currentVersionId) {
    throw new Error(`Research-lab profile ${profile.name} has no active version.`);
  }
  const version = await loadResearchLabProfileVersion(env, profile.currentVersionId);
  if (!version) {
    throw new Error(`Research-lab profile version ${profile.currentVersionId} was not found.`);
  }
  return resolveResearchLabProfileAtVersion(env, profile.id, version.id);
}

export async function createResearchLabProfile(env: Env, payload: {
  slug: string;
  name: string;
  description?: string | null;
  isActive?: boolean;
  isDefault?: boolean;
}): Promise<{ id: string }> {
  const id = uid();
  const statements = [];
  if (payload.isDefault) {
    statements.push(env.DB.prepare("UPDATE research_lab_profiles SET is_default = 0 WHERE is_default = 1"));
  }
  statements.push(
    env.DB.prepare(
      "INSERT INTO research_lab_profiles (id, slug, name, description, is_active, is_default, current_version_id) VALUES (?, ?, ?, ?, ?, ?, NULL)",
    ).bind(id, payload.slug, payload.name, payload.description ?? null, payload.isActive === false ? 0 : 1, payload.isDefault ? 1 : 0),
  );
  await env.DB.batch(statements);
  return { id };
}

export async function updateResearchLabProfile(env: Env, profileId: string, payload: {
  slug?: string;
  name?: string;
  description?: string | null;
  isActive?: boolean;
  isDefault?: boolean;
  currentVersionId?: string | null;
}): Promise<void> {
  const current = await loadResearchLabProfile(env, profileId);
  if (!current) throw new Error("Research-lab profile not found.");
  const next = {
    slug: payload.slug ?? current.slug,
    name: payload.name ?? current.name,
    description: payload.description === undefined ? current.description : payload.description,
    isActive: payload.isActive === undefined ? current.isActive : payload.isActive,
    isDefault: payload.isDefault === undefined ? current.isDefault : payload.isDefault,
    currentVersionId: payload.currentVersionId === undefined ? current.currentVersionId : payload.currentVersionId,
  };
  const statements = [];
  if (next.isDefault) {
    statements.push(env.DB.prepare("UPDATE research_lab_profiles SET is_default = 0 WHERE is_default = 1 AND id <> ?").bind(profileId));
  }
  statements.push(
    env.DB.prepare(
      "UPDATE research_lab_profiles SET slug = ?, name = ?, description = ?, is_active = ?, is_default = ?, current_version_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).bind(next.slug, next.name, next.description ?? null, next.isActive ? 1 : 0, next.isDefault ? 1 : 0, next.currentVersionId ?? null, profileId),
  );
  await env.DB.batch(statements);
}

export async function createResearchLabProfileVersion(env: Env, profileId: string, payload: {
  label: string;
  modelFamily: string;
  systemPrompt: string;
  schemaVersion: string;
  evidenceConfigJson: Record<string, unknown>;
  synthesisConfigJson: Record<string, unknown>;
  modulesConfigJson: Record<string, unknown>;
  activate?: boolean;
}): Promise<{ id: string; versionNumber: number }> {
  const current = await env.DB.prepare(
    "SELECT COALESCE(MAX(version_number), 0) as maxVersion FROM research_lab_profile_versions WHERE profile_id = ?",
  ).bind(profileId).first<{ maxVersion: number | null }>();
  const versionNumber = (current?.maxVersion ?? 0) + 1;
  const id = uid();
  await env.DB.prepare(
    "INSERT INTO research_lab_profile_versions (id, profile_id, version_number, label, model_family, system_prompt, schema_version, evidence_config_json, synthesis_config_json, modules_config_json, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
  ).bind(
    id,
    profileId,
    versionNumber,
    payload.label,
    payload.modelFamily,
    payload.systemPrompt,
    payload.schemaVersion,
    JSON.stringify(payload.evidenceConfigJson),
    JSON.stringify(payload.synthesisConfigJson),
    JSON.stringify(payload.modulesConfigJson ?? {}),
  ).run();
  if (payload.activate !== false) {
    await updateResearchLabProfile(env, profileId, { currentVersionId: id });
  }
  return { id, versionNumber };
}
