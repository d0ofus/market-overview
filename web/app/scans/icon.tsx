import { createTabIcon, iconContentType, iconSize } from "../icon-utils";

export const size = iconSize;
export const contentType = iconContentType;

export default function Icon() {
  return createTabIcon({ label: "SC", bg: "#0f766e", accent: "rgba(153,246,228,0.28)" });
}
