import { createTabIcon, iconContentType, iconSize } from "../icon-utils";

export const size = iconSize;
export const contentType = iconContentType;

export default function Icon() {
  return createTabIcon({ label: "WC", bg: "#334155", accent: "rgba(226,232,240,0.28)" });
}
