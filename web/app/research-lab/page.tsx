import { ResearchLabDashboard } from "@/components/research-lab-dashboard";

export default function ResearchLabPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Research Lab</h2>
        <p className="text-sm text-slate-400">
          Test the new isolated stock research flow with live per-ticker logging, persisted evidence artifacts, and strict no-fallback synthesis.
        </p>
      </div>
      <ResearchLabDashboard />
    </div>
  );
}
