"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

type Props = {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  anchorId?: string;
  children: React.ReactNode;
};

export function AdminSection({ title, description, defaultOpen = true, anchorId, children }: Props) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <section className="card overflow-hidden scroll-mt-24" id={anchorId}>
      <button
        className="flex w-full items-center justify-between border-b border-borderSoft px-4 py-3 text-left"
        onClick={() => setIsOpen((value) => !value)}
        type="button"
      >
        <div>
          <h2 className="text-xl font-semibold">{title}</h2>
          {description ? <p className="text-sm text-slate-400">{description}</p> : null}
        </div>
        <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>
      {isOpen ? <div className="p-4">{children}</div> : null}
    </section>
  );
}
