import { createTabIcon, iconContentType, iconSize } from "../../icon-utils";

export const size = iconSize;
export const contentType = iconContentType;

export default function Icon() {
  return createTabIcon({ label: "TK", bg: "#0f172a", accent: "rgba(125,211,252,0.28)" });
}
