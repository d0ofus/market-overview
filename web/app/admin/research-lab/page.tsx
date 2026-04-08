import type { Metadata } from "next";
import { ResearchLabAdminPanel } from "@/components/research-lab-admin-panel";

export const metadata: Metadata = {
  title: "AI Research Admin",
};

export default function AdminResearchLabPage() {
  return <ResearchLabAdminPanel />;
}
