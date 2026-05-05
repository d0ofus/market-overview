import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Social Alerts",
};

export default function SocialAlertsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
