"use client";

export default function Error({ error }: { error: Error }) {
  return (
    <div className="card p-4 text-sm text-red-300">
      Failed to load dashboard data: {error.message}
    </div>
  );
}
