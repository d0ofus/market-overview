import { createTabIcon, iconContentType, iconSize } from "../icon-utils";

export const size = iconSize;
export const contentType = iconContentType;

export default function Icon() {
  return createTabIcon({ label: "ER", bg: "#0f172a", fg: "#22d3ee", accent: "rgba(52,211,153,0.28)" });
}
