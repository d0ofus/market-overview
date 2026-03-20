import { createTabIcon, iconContentType, iconSize } from "../icon-utils";

export const size = iconSize;
export const contentType = iconContentType;

export default function Icon() {
  return createTabIcon({ label: "BR", bg: "#4c1d95", accent: "rgba(221,214,254,0.28)" });
}
