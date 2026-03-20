import { createTabIcon, iconContentType, iconSize } from "../icon-utils";

export const size = iconSize;
export const contentType = iconContentType;

export default function Icon() {
  return createTabIcon({ label: "SN", bg: "#1d4ed8", accent: "rgba(191,219,254,0.28)" });
}
