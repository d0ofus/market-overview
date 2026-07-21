import type { Hono } from "hono";
import { loadStoredFedWatchSnapshot } from "../fedwatch-service";
import type { Env } from "../types";

export function registerFedWatchRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/fedwatch", async (c) => {
    try {
      const snapshot = await loadStoredFedWatchSnapshot(c.env);
      c.header("Cache-Control", "public, max-age=300");
      return c.json(snapshot);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Failed to load FedWatch." }, 500);
    }
  });
}
