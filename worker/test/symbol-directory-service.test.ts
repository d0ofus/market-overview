import { describe, expect, it } from "vitest";
import { isSymbolCatalogSyncDue } from "../src/symbol-directory-service";

describe("symbol directory schedule helpers", () => {
  it("treats missing or invalid timestamps as due", () => {
    expect(isSymbolCatalogSyncDue(null, new Date("2026-04-05T00:00:00.000Z"))).toBe(true);
    expect(isSymbolCatalogSyncDue("not-a-date", new Date("2026-04-05T00:00:00.000Z"))).toBe(true);
  });

  it("waits for a full day before scheduled sync runs again", () => {
    const now = new Date("2026-04-05T12:00:00.000Z");
    expect(isSymbolCatalogSyncDue("2026-04-04T13:00:00.000Z", now)).toBe(false);
    expect(isSymbolCatalogSyncDue("2026-04-04T11:59:59.000Z", now)).toBe(true);
  });
});
