import type { Metadata } from "next";

import { AppShell } from "./components/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "周大福营销活动生成 Agent",
  description: "从一句活动需求生成营销方案与 ICS 开单草稿",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
