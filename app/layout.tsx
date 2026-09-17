import type { Metadata } from "next";

import { AppShell } from "./components/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "周大福营销活动 AI 工作台",
  description: "从开放式对话整理营销活动 Brief、编排执行流程，并按需准备系统配置和对外传播内容",
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
