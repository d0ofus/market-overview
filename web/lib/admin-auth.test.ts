import assert from "node:assert/strict";
import test from "node:test";
import { getAdminWorkerConfig } from "./admin-auth";

test("admin worker config keeps localhost fallback in development", () => {
  const config = getAdminWorkerConfig({ ADMIN_SECRET: "secret", NODE_ENV: "development" } as NodeJS.ProcessEnv);

  assert.equal(config.configured, true);
  assert.equal(config.apiBase, "http://127.0.0.1:8787");
});

test("admin worker config requires explicit worker api base in production", () => {
  const config = getAdminWorkerConfig({ ADMIN_SECRET: "secret", NODE_ENV: "production" } as NodeJS.ProcessEnv);

  assert.equal(config.configured, false);
  assert.deepEqual(config.missing, ["WORKER_API_BASE"]);
});

test("admin worker config reports invalid api base", () => {
  const config = getAdminWorkerConfig({ ADMIN_SECRET: "secret", NODE_ENV: "production", WORKER_API_BASE: "not a url" } as NodeJS.ProcessEnv);

  assert.equal(config.configured, false);
  assert.deepEqual(config.missing, ["WORKER_API_BASE"]);
});
