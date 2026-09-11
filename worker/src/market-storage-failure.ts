export type StorageFailure = {
  code:string;
  retryable:boolean;
  quota:boolean;
  httpStatus?:number;
  providerCodes?:number[];
};

/** Preserve the actionable adapter category without exposing SQL, bindings,
 * response bodies, credentials, or arbitrary nested Error text in public logs. */
export function classifyStorageFailure(error:unknown):StorageFailure {
  const message=error instanceof Error ? error.message : "";
  const quota=/\b(?:[a-z0-9-]*budget-exhausted|[a-z0-9-]*quota-exhausted)\b/.test(message);
  if (quota) return {code:"storage-quota-deferred",retryable:true,quota:true};
  if (/\b(?:d1-capacity-exhausted|eod-capacity-exceeded)\b/.test(message)) {
    return {code:"storage-capacity-exhausted",retryable:false,quota:false};
  }
  const http=/^d1-http-(\d{3})(?:: codes=([\d,]+))?/.exec(message);
  if (http) {
    const httpStatus=Number(http[1]);
    const providerCodes=http[2]?.split(",").slice(0,8).map(Number).filter(Number.isSafeInteger);
    return {code:httpStatus===429 ? "d1-api-rate-limited" : `d1-http-${httpStatus}`,
      httpStatus,...(providerCodes?.length ? {providerCodes} : {}),
      retryable:httpStatus===429 || httpStatus>=500,quota:false};
  }
  const invalidJson=/^d1-response-invalid-json: status=(\d{3})$/.exec(message);
  if (invalidJson) return {code:"d1-response-invalid-json",httpStatus:Number(invalidJson[1]),
    retryable:Number(invalidJson[1])>=500,quota:false};
  if (["d1-network-error","d1-request-timeout","storage-run-time-slice-complete","storage-verification-time-slice-complete",
    "storage-bootstrap-incomplete","storage-bootstrap-retry-not-due"].includes(message)) {
    return {code:message,retryable:true,quota:false};
  }
  // These are repository-defined error namespaces. Free-form provider text is
  // never propagated, even if it happens to contain a recognizable phrase.
  const code=/^(?:storage|d1|eod)-[a-z0-9-]{1,90}$/.test(message) ? message : "storage-copy-verification-failed";
  return {code,retryable:false,quota:false};
}
