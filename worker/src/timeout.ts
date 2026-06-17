export function resolveFetchTimeoutMs(value: string | number | null | undefined, defaultMs: number): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultMs;
  return Math.max(1_000, Math.min(120_000, Math.round(parsed)));
}

export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
