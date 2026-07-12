import { describe, expect, it } from "vitest";
import {
  isAdminRequestAuthorized,
  isOverviewRolloutRequestAuthorized,
  shouldAllowFedWatchForceRefresh,
} from "../src/index";
import type { Env } from "../src/types";

function request(auth?: string): Request {
  return new Request("https://example.com/api/test", {
    headers: auth ? { authorization: auth } : undefined,
  });
}

function env(values: Record<string, unknown>): Env {
  return values as unknown as Env;
}

describe("worker security hardening helpers", () => {
  it("keeps missing ADMIN_SECRET compatible by default", () => {
    expect(isAdminRequestAuthorized(request(), env({}))).toBe(true);
  });

  it("can fail closed when ADMIN_AUTH_FAIL_CLOSED is enabled and ADMIN_SECRET is missing", () => {
    expect(isAdminRequestAuthorized(request(), env({ ADMIN_AUTH_FAIL_CLOSED: "true" }))).toBe(false);
  });

  it("accepts the configured admin bearer secret", () => {
    expect(isAdminRequestAuthorized(request("Bearer secret"), env({ ADMIN_SECRET: "secret", ADMIN_AUTH_FAIL_CLOSED: "true" }))).toBe(true);
  });

  it("keeps overview rollout endpoints fail-closed without an explicit secret", () => {
    expect(isOverviewRolloutRequestAuthorized(request(), env({}))).toBe(false);
    expect(isOverviewRolloutRequestAuthorized(request("Bearer anything"), env({}))).toBe(false);
  });

  it("accepts either scoped rollout or admin credentials for overview rollout endpoints", () => {
    const configured = env({ ADMIN_SECRET: "admin", OVERVIEW_ROLLOUT_SECRET: "rollout" });
    expect(isOverviewRolloutRequestAuthorized(request("Bearer rollout"), configured)).toBe(true);
    expect(isOverviewRolloutRequestAuthorized(request("Bearer admin"), configured)).toBe(true);
    expect(isOverviewRolloutRequestAuthorized(request("Bearer wrong"), configured)).toBe(false);
  });

  it("rejects forced FedWatch refresh for public callers by default", () => {
    expect(shouldAllowFedWatchForceRefresh(request(), env({}))).toBe(false);
  });

  it("allows forced FedWatch refresh for public callers only with the rollout fallback flag", () => {
    expect(shouldAllowFedWatchForceRefresh(request(), env({ FEDWATCH_PUBLIC_FORCE_REFRESH: "true" }))).toBe(true);
  });

  it("allows forced FedWatch refresh for authenticated admin callers", () => {
    expect(shouldAllowFedWatchForceRefresh(request("Bearer secret"), env({ ADMIN_SECRET: "secret" }))).toBe(true);
  });
});
