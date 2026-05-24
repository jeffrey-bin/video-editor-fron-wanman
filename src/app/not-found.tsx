import Link from "next/link";

export default function NotFound() {
  return (
    <main className="not-found-page">
      <section className="not-found-panel">
        <p className="eyebrow">404</p>
        <h1>页面不存在</h1>
        <p>未找到请求的 PromptCut Studio 页面。</p>
        <Link href="/">返回编辑器</Link>
      </section>
    </main>
  );
}
