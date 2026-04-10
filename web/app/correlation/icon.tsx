import { createTabIcon, iconContentType, iconSize } from "../icon-utils";

export const size = iconSize;
export const contentType = iconContentType;

export default function Icon() {
  return createTabIcon({ label: "CO", bg: "#365314", accent: "rgba(217,249,157,0.28)" });
}
