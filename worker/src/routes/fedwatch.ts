import type { Hono } from "hono";
import { shouldAllowFedWatchForceRefresh } from "../auth";
import { getFedWatchSnapshot } from "../fedwatch-service";
import type { Env } from "../types";

export function registerFedWatchRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/fedwatch", async (c) => {
    try {
      const forceRequested = c.req.query("force") === "1";
      const snapshot = await getFedWatchSnapshot(c.env, {
        force: forceRequested && shouldAllowFedWatchForceRefresh(c.req.raw, c.env),
      });
      c.header("Cache-Control", "public, max-age=300");
      return c.json(snapshot);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Failed to load FedWatch." }, 500);
    }
  });
}
