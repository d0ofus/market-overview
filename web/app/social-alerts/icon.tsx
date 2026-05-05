import { createTabIcon, iconContentType, iconSize } from "../icon-utils";

export const size = iconSize;
export const contentType = iconContentType;

export default function Icon() {
  return createTabIcon({ label: "SA", bg: "#0f766e", accent: "rgba(45,212,191,0.25)" });
}
