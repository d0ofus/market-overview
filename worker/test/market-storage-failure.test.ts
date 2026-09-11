import { describe, expect, it } from "vitest";
import { classifyStorageFailure } from "../src/market-storage-failure";

describe("sanitized storage interruption diagnostics", () => {
  it("identifies underestimated billed work without exposing query diagnostics or treating it as exhausted quota", () => {
    expect(classifyStorageFailure(new Error("eod-d1-query-budget-estimate-exceeded; reads=1600/2432; writes=1600/1208; statements=1; classes=universe-stage; private token")))
      .toEqual({code:"storage-query-estimate-exceeded",retryable:false,quota:false});
  });
  it.each(["d1-request-timeout","d1-network-error","storage-run-time-slice-complete"])("retains actionable %s", (code) => {
    expect(classifyStorageFailure(new Error(code))).toEqual({code,retryable:true,quota:false});
  });
  it("keeps HTTP and numeric provider codes while dropping provider text", () => {
    expect(classifyStorageFailure(new Error("d1-http-503: codes=7500; private SQL/token")))
      .toEqual({code:"d1-http-503",httpStatus:503,providerCodes:[7500],retryable:true,quota:false});
    expect(classifyStorageFailure(new Error("d1-http-401: codes=10001; private token")))
      .toMatchObject({code:"d1-http-401",httpStatus:401,retryable:false});
  });
  it("distinguishes API cooldown, UTC quota exhaustion and capacity requiring intervention", () => {
    expect(classifyStorageFailure(new Error("d1-http-429: codes=10023; d1-api-rate-limited")))
      .toMatchObject({code:"d1-api-rate-limited",retryable:true,quota:false});
    expect(classifyStorageFailure(new Error("d1-http-400: codes=7500; d1-quota-exhausted")))
      .toEqual({code:"storage-quota-deferred",retryable:true,quota:true});
    expect(classifyStorageFailure(new Error("d1-http-400: codes=7500; d1-capacity-exhausted")))
      .toEqual({code:"storage-capacity-exhausted",retryable:false,quota:false});
  });
  it("does not retry integrity failures or expose arbitrary error bodies", () => {
    expect(classifyStorageFailure(new Error("storage-archive-readback-mismatch")))
      .toEqual({code:"storage-archive-readback-mismatch",retryable:false,quota:false});
    expect(classifyStorageFailure(new Error("Authorization: private-value SELECT * FROM private_table")))
      .toEqual({code:"storage-copy-verification-failed",retryable:false,quota:false});
  });
  it.each(["eod-account-window-unavailable","eod-account-usage-unavailable","eod-account-usage-date-changed",
    "storage-population-verified-memberships-required"])(
    "resumes checkpoints after transient telemetry recovery: %s",(code) => {
      expect(classifyStorageFailure(new Error(code))).toEqual({code,retryable:true,quota:false});
    });
});
