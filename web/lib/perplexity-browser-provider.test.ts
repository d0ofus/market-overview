import assert from "node:assert/strict";
import test from "node:test";
import { selectPerplexityBrowserProvider } from "./perplexity-browser-provider";

test("selects local Chromium when Browserbase env is absent", () => {
  const decision = selectPerplexityBrowserProvider({});
  assert.equal(decision.provider, "local_chromium");
  assert.equal(decision.browserbaseConfigured, false);
  assert.deepEqual(decision.missingBrowserbaseEnv, [
    "BROWSERBASE_API_KEY",
    "BROWSERBASE_PROJECT_ID",
    "BROWSERBASE_CONTEXT_ID",
  ]);
});

test("selects Browserbase when required env vars are present", () => {
  const decision = selectPerplexityBrowserProvider({
    BROWSERBASE_API_KEY: "key",
    BROWSERBASE_PROJECT_ID: "project",
    BROWSERBASE_CONTEXT_ID: "context",
  });
  assert.equal(decision.provider, "browserbase");
  assert.equal(decision.browserbaseConfigured, true);
  assert.deepEqual(decision.missingBrowserbaseEnv, []);
});

test("falls back to local Chromium when Browserbase is requested but incomplete", () => {
  const decision = selectPerplexityBrowserProvider({
    PERPLEXITY_BROWSER_PROVIDER: "browserbase",
    BROWSERBASE_API_KEY: "key",
  });
  assert.equal(decision.provider, "local_chromium");
  assert.equal(decision.browserbaseConfigured, false);
  assert.match(decision.reason ?? "", /BROWSERBASE_PROJECT_ID/);
  assert.match(decision.reason ?? "", /BROWSERBASE_CONTEXT_ID/);
});

test("honors an explicit local Chromium provider even when Browserbase is configured", () => {
  const decision = selectPerplexityBrowserProvider({
    PERPLEXITY_BROWSER_PROVIDER: "local_chromium",
    BROWSERBASE_API_KEY: "key",
    BROWSERBASE_PROJECT_ID: "project",
    BROWSERBASE_CONTEXT_ID: "context",
  });
  assert.equal(decision.provider, "local_chromium");
  assert.equal(decision.browserbaseConfigured, true);
});
