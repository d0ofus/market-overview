import { AdminBuilder } from "@/components/admin-builder";

export default function AdminPage() {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Dashboard Builder</h2>
      <p className="text-sm text-slate-400">
        Configure groups, ranking windows, visible columns, and tickers without code changes.
      </p>
      <AdminBuilder />
    </div>
  );
}
