import type { Metadata } from "next";

import { AppShell } from "./components/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "周大福 ICS-1811 AI 活动工作台",
  description: "通过真实 AI 工具调用，从一句活动需求生成并校验 ICS-1811 填写草稿",
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
