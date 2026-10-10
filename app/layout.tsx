import type { Metadata } from "next";

import { AppShell } from "./components/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "周大福营销决策工作台",
  description: "基于经营数据复盘历史活动，查看分组差异和数据依据，并衔接活动执行、优惠配置和传播方案",
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
