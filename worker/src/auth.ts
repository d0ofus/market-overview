import type { Env } from "./types";

export function envFlagEnabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export const isAdminRequestAuthorized = (req: Request, env: Env): boolean => {
  const secret = env.ADMIN_SECRET;
  if (!secret) return !envFlagEnabled(env.ADMIN_AUTH_FAIL_CLOSED);
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  return auth.slice(7) === secret;
};

export const isOverviewRolloutRequestAuthorized = (req: Request, env: Env): boolean => {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  return Boolean(
    (env.ADMIN_SECRET && token === env.ADMIN_SECRET)
    || (env.OVERVIEW_ROLLOUT_SECRET && token === env.OVERVIEW_ROLLOUT_SECRET),
  );
};

export const shouldAllowFedWatchForceRefresh = (req: Request, env: Env): boolean => {
  if (envFlagEnabled(env.FEDWATCH_PUBLIC_FORCE_REFRESH)) return true;
  return Boolean(env.ADMIN_SECRET) && isAdminRequestAuthorized(req, env);
};
