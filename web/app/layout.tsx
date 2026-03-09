import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { EscCloseListener } from "@/components/esc-close-listener";

export const metadata: Metadata = {
  title: "Market Command Centre | Overview",
  description: "EOD-first swing trading research dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('market_command_theme');var n=t==='light'?'light':'dark';var d=document.documentElement;d.classList.remove('dark','light');d.classList.add(n);}catch(e){document.documentElement.classList.add('dark');}})();",
          }}
        />
      </head>
      <body>
        <EscCloseListener />
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="flex-1 p-4 md:p-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
