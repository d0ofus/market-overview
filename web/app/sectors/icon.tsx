import { createTabIcon, iconContentType, iconSize } from "../icon-utils";

export const size = iconSize;
export const contentType = iconContentType;

export default function Icon() {
  return createTabIcon({ label: "SE", bg: "#854d0e", accent: "rgba(253,224,71,0.28)" });
}
