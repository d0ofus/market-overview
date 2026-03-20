import { createTabIcon, iconContentType, iconSize } from "../icon-utils";

export const size = iconSize;
export const contentType = iconContentType;

export default function Icon() {
  return createTabIcon({ label: "PG", bg: "#166534", accent: "rgba(187,247,208,0.28)" });
}
