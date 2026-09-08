"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getEodPublicationStatus, type EodPublicationStatus } from "@/lib/api";

export function EodPublicationMonitor({ scope, generationId }: { scope: "overview" | "breadth"; generationId?: string | null }) {
  const router = useRouter();
  const seen = useRef<string | null>(generationId ?? null);
  const [status, setStatus] = useState<EodPublicationStatus | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let pending = false;
    let lastPollAt = 0;
    const clock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23" });
    const poll = async (force = false) => {
      if (document.visibilityState !== "visible" || pending) return;
      const now = new Date();
      const parts = clock.formatToParts(now);
      const weekday = parts.find((part) => part.type === "weekday")?.value;
      const hour = Number(parts.find((part) => part.type === "hour")?.value);
      const weekdaySession = weekday !== "Sat" && weekday !== "Sun";
      const deliveryWindow = weekdaySession && (hour === 9 || (hour >= 13 && hour <= 18));
      if (!force && now.getTime() - lastPollAt < (deliveryWindow ? 60_000 : 300_000)) return;
      lastPollAt = now.getTime();
      pending = true;
      try {
        const next = await getEodPublicationStatus({ signal: AbortSignal.timeout(10_000) });
        if (cancelled) return;
        setStatus(next);
        setWarning(null);
        const publicationIds = next.publications.filter((entry) => entry.scope === scope || entry.scope.startsWith(`${scope}:`))
          .map((entry) => `${entry.scope}:${entry.publication_id}`).sort().join("|");
        if (publicationIds && publicationIds !== seen.current) {
          seen.current = publicationIds;
          window.dispatchEvent(new Event("market-data-updated"));
          router.refresh();
        }
      } catch {
        if (!cancelled) setWarning("Publication status could not be checked; displaying the dated data already loaded.");
      } finally {
        pending = false;
      }
    };
    void poll(true);
    const timer = window.setInterval(() => void poll(), 60_000);
    const onVisibilityChange = () => void poll(true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibilityChange); };
  }, [router, scope]);
  const run = status?.runs[0];
  return <div className="text-xs text-slate-400" role="status">
    EOD target: within 2 hours of the US cash close, including early closes. Source dates and coverage determine availability.
    {run && <span> Latest attempt: {run.session_date}, {run.status}{run.stage ? ` (${run.stage})` : ""}.</span>}
    {status?.inputCorrectionsPending === true && <span className="ml-1 text-warning">Stored inputs changed; corrected publications are pending. Displayed values remain dated.</span>}
    {status?.inputCorrectionsPending === null && <span className="ml-1 text-warning">Input correction status is unavailable; matching session dates alone cannot confirm readiness.</span>}
    {warning && <span className="ml-1 text-warning">{warning}</span>}
  </div>;
}
