import { createTabIcon, iconContentType, iconSize } from "../icon-utils";

export const size = iconSize;
export const contentType = iconContentType;

export default function Icon() {
  return createTabIcon({ label: "AL", bg: "#7c2d12", accent: "rgba(254,215,170,0.28)" });
}
