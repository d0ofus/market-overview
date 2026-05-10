import { createTabIcon, iconContentType, iconSize } from "../icon-utils";

export const size = iconSize;
export const contentType = iconContentType;

export default function Icon() {
  return createTabIcon({ label: "PS", bg: "#155e75", accent: "rgba(165,243,252,0.28)" });
}
