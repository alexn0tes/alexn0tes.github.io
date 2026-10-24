import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "拾知 · Alex Notes",
  description: "拾起灵感，积累认知。属于你的私人知识空间，记录笔记、整理想法，让知识慢慢生长。",
  robots: { index: false, follow: false },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{children: React.ReactNode}>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
