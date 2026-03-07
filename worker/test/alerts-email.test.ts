import { describe, expect, it } from "vitest";
import { senderAllowed } from "../src/alerts-email";

describe("alerts email allowlist", () => {
  it("allows tradingview sender by default", () => {
    expect(senderAllowed("noreply@tradingview.com", {} as any)).toBe(true);
    expect(senderAllowed("alerts@other.com", {} as any)).toBe(false);
  });

  it("supports comma-separated custom allowlist", () => {
    const env = { ALERTS_EMAIL_ALLOWED_FROM: "tradingview.com,mailgun.org" } as any;
    expect(senderAllowed("foo@mailgun.org", env)).toBe(true);
    expect(senderAllowed("noreply@tradingview.com", env)).toBe(true);
    expect(senderAllowed("foo@example.com", env)).toBe(false);
  });
});
