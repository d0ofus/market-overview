import { createTabIcon, iconContentType, iconSize } from "../icon-utils";

export const size = iconSize;
export const contentType = iconContentType;

export default function Icon() {
  return createTabIcon({ label: "AD", bg: "#111827", accent: "rgba(156,163,175,0.28)" });
}
