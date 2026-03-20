import { createTabIcon, iconContentType, iconSize } from "../icon-utils";

export const size = iconSize;
export const contentType = iconContentType;

export default function Icon() {
  return createTabIcon({ label: "GP", bg: "#991b1b", accent: "rgba(254,202,202,0.28)" });
}
