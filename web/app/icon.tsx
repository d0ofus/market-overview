import { createTabIcon, iconContentType, iconSize } from "./icon-utils";

export const size = iconSize;
export const contentType = iconContentType;

export default function Icon() {
  return createTabIcon({ label: "OV", bg: "#9f1239", accent: "rgba(251,207,232,0.28)" });
}
