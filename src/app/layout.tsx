import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PromptCut Studio",
  description: "支持 LLM Prompt 的音视频编辑器 P0",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
