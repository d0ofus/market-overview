import { createTabIcon, iconContentType, iconSize } from "../icon-utils";

export const size = iconSize;
export const contentType = iconContentType;

export default function Icon() {
  return createTabIcon({ label: "13", bg: "#3f3f46", accent: "rgba(228,228,231,0.28)" });
}
