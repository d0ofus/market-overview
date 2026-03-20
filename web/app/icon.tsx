import { createTabIcon, iconContentType, iconSize } from "./icon-utils";

export const size = iconSize;
export const contentType = iconContentType;

export default function Icon() {
  return createTabIcon({ label: "MC", bg: "#0f172a", accent: "rgba(56,189,248,0.28)" });
}
