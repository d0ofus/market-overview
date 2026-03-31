export function createResearchProgressPump(work: () => Promise<unknown>) {
  let inFlight: Promise<void> | null = null;
  let lastError: Error | null = null;

  return {
    start() {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          await work();
        } catch (error) {
          lastError = error instanceof Error ? error : new Error("Research progress pump failed.");
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
    throwIfErrored() {
      if (!lastError) return;
      const error = lastError;
      lastError = null;
      throw error;
    },
    isInFlight() {
      return inFlight !== null;
    },
  };
}
