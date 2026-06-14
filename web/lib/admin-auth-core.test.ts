import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_SESSION_MAX_AGE_SECONDS,
  createAdminSessionValue,
  verifyAdminPassword,
  verifyAdminSessionValue,
} from "./admin-auth-core";

test("admin session values verify with the signing secret", () => {
  const now = Date.UTC(2026, 4, 28);
  const value = createAdminSessionValue("test-session-secret", {
    now,
    nonce: "fixed-nonce",
  });

  const verification = verifyAdminSessionValue(value, "test-session-secret", now + 1000);

  assert.equal(verification.valid, true);
  if (verification.valid) {
    assert.equal(verification.payload.exp, now + ADMIN_SESSION_MAX_AGE_SECONDS * 1000);
  }
});

test("admin session values reject payload tampering", () => {
  const value = createAdminSessionValue("test-session-secret", {
    now: Date.UTC(2026, 4, 28),
    nonce: "fixed-nonce",
  });
  const [payload, signature] = value.split(".");
  const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith("a") ? "b" : "a"}`;

  const verification = verifyAdminSessionValue(`${tamperedPayload}.${signature}`, "test-session-secret");

  assert.deepEqual(verification, { valid: false, reason: "signature" });
});

test("admin session values reject expired cookies", () => {
  const now = Date.UTC(2026, 4, 28);
  const value = createAdminSessionValue("test-session-secret", {
    now,
    maxAgeSeconds: 60,
    nonce: "fixed-nonce",
  });

  const verification = verifyAdminSessionValue(value, "test-session-secret", now + 61_000);

  assert.deepEqual(verification, { valid: false, reason: "expired" });
});

test("admin password validation is exact", () => {
  assert.equal(verifyAdminPassword("correct horse battery staple", "correct horse battery staple"), true);
  assert.equal(verifyAdminPassword("correct horse battery staple ", "correct horse battery staple"), false);
  assert.equal(verifyAdminPassword("", "correct horse battery staple"), false);
  assert.equal(verifyAdminPassword("correct horse battery staple", ""), false);
});
