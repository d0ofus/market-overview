"use client";

import { useEffect } from "react";

export function EscCloseListener() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const closers = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-modal-close=\"true\"]"));
      const target = closers[closers.length - 1];
      if (target) {
        target.click();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return null;
}

