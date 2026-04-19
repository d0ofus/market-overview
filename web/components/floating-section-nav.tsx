"use client";

import { useEffect, useState } from "react";

type FloatingSectionNavItem = {
  id: string;
  label: string;
};

type Props = {
  items: FloatingSectionNavItem[];
  showHeading?: boolean;
  stickyOffset?: number;
};

function navigationButtonClass(active: boolean) {
  return active
    ? "bg-accent/16 text-accent shadow-[inset_0_0_0_1px_rgba(56,189,248,0.28)]"
    : "bg-panelSoft/45 text-slate-300 shadow-[inset_0_0_0_1px_rgba(148,163,184,0.08)] hover:bg-panelSoft/65";
}

export function FloatingSectionNav({ items, showHeading = true, stickyOffset = 148 }: Props) {
  const [activeSection, setActiveSection] = useState(items[0]?.id ?? "");

  useEffect(() => {
    setActiveSection((current) => (items.some((item) => item.id === current) ? current : (items[0]?.id ?? "")));
  }, [items]);

  useEffect(() => {
    if (!items.length || typeof window === "undefined" || typeof IntersectionObserver === "undefined") return;

    const getSections = () =>
      items
        .map(({ id }) => {
          const element = document.getElementById(id);
          if (!element) return null;
          return { id, element };
        })
        .filter((section): section is { id: string; element: HTMLElement } => section !== null);

    const updateActiveFromViewport = () => {
      const sections = getSections();
      if (sections.length === 0) return;

      let nextActive = sections[0].id;
      let nearestPassedTop = Number.NEGATIVE_INFINITY;
      let nearestUpcomingTop = Number.POSITIVE_INFINITY;

      for (const section of sections) {
        const offsetTop = section.element.getBoundingClientRect().top - stickyOffset;
        if (offsetTop <= 0 && offsetTop > nearestPassedTop) {
          nearestPassedTop = offsetTop;
          nextActive = section.id;
        } else if (nearestPassedTop === Number.NEGATIVE_INFINITY && offsetTop < nearestUpcomingTop) {
          nearestUpcomingTop = offsetTop;
          nextActive = section.id;
        }
      }

      setActiveSection((current) => (current === nextActive ? current : nextActive));
    };

    const observer = new IntersectionObserver(
      () => {
        updateActiveFromViewport();
      },
      {
        root: null,
        rootMargin: "-120px 0px -55% 0px",
        threshold: [0, 0.1, 0.35, 0.65, 1],
      },
    );

    for (const section of getSections()) {
      observer.observe(section.element);
    }

    updateActiveFromViewport();
    window.addEventListener("resize", updateActiveFromViewport);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateActiveFromViewport);
    };
  }, [items, stickyOffset]);

  if (items.length === 0) return null;

  return (
    <div className="sticky top-4 z-20">
      <nav className="overflow-x-auto rounded-[26px] border border-borderSoft/70 bg-panel/88 shadow-[0_18px_44px_rgba(2,6,23,0.24)] backdrop-blur-xl">
        <div className="flex min-w-max items-center gap-3 px-4 py-4 md:px-5">
          {showHeading ? (
            <>
              <div className="pr-1">
                <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Jump to</div>
                <div className="mt-1 text-sm font-medium text-slate-300">Sections</div>
              </div>
              <div className="h-8 w-px bg-borderSoft/70" aria-hidden="true" />
            </>
          ) : null}
          <div className="flex min-w-max gap-2">
            {items.map((item) => (
              <button
                key={item.id}
                className={`rounded-full px-4 py-2 text-sm font-medium transition ${navigationButtonClass(activeSection === item.id)}`}
                onClick={() => {
                  setActiveSection(item.id);
                  document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                aria-pressed={activeSection === item.id}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </nav>
    </div>
  );
}
