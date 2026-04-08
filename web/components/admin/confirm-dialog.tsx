"use client";

import { Loader2, X } from "lucide-react";

type Props = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
};

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  busy = false,
  onCancel,
  onConfirm,
}: Props) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm" onClick={onCancel}>
      <div className="admin-surface w-full max-w-md px-5 py-5" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-text">{title}</h3>
            <p className="text-sm text-slate-400">{description}</p>
          </div>
          <button
            data-modal-close="true"
            className="rounded-xl border border-borderSoft/70 p-2 text-slate-300 transition hover:bg-panelSoft/70"
            onClick={onCancel}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            data-modal-close="true"
            className="rounded-xl border border-borderSoft/80 bg-panelSoft/65 px-4 py-2 text-sm text-slate-200 transition hover:bg-panelSoft"
            onClick={onCancel}
            type="button"
          >
            {cancelLabel}
          </button>
          <button
            className={`rounded-xl px-4 py-2 text-sm font-medium transition disabled:opacity-60 ${
              tone === "danger"
                ? "border border-rose-400/30 bg-rose-500/15 text-rose-100 hover:bg-rose-500/20"
                : "bg-accent text-slate-950 hover:brightness-110"
            }`}
            disabled={busy}
            onClick={() => void onConfirm()}
            type="button"
          >
            {busy ? <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Working...</span> : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
