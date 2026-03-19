"use client";

export function ChartGridPager({
  totalItems,
  page,
  pageSize,
  itemLabel,
  onPageChange,
}: {
  totalItems: number;
  page: number;
  pageSize: number;
  itemLabel: string;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const start = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const end = totalItems === 0 ? 0 : Math.min(totalItems, currentPage * pageSize);

  if (totalItems <= pageSize) return null;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-slate-300/70 bg-slate-100/95 px-3 py-2 text-xs text-slate-700 dark:border-borderSoft/70 dark:bg-panelSoft/30 dark:text-slate-200">
      <span>
        Showing {start}-{end} of {totalItems} {itemLabel}
      </span>
      <span className="rounded bg-white/90 px-2 py-1 text-slate-700 shadow-sm dark:bg-slate-800/80 dark:text-slate-200 dark:shadow-none">
        Page {currentPage} of {totalPages}
      </span>
      <button
        className="rounded border border-slate-300 bg-white/90 px-2 py-1 text-slate-700 shadow-sm disabled:cursor-not-allowed disabled:opacity-50 dark:border-borderSoft dark:bg-slate-800/80 dark:text-slate-200 dark:shadow-none"
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage <= 1}
        type="button"
      >
        Prev
      </button>
      <button
        className="rounded border border-slate-300 bg-white/90 px-2 py-1 text-slate-700 shadow-sm disabled:cursor-not-allowed disabled:opacity-50 dark:border-borderSoft dark:bg-slate-800/80 dark:text-slate-200 dark:shadow-none"
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage >= totalPages}
        type="button"
      >
        Next
      </button>
    </div>
  );
}
