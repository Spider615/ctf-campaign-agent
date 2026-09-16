"use client";

import { parseChatMarkdown, type InlineNode } from "../../lib/markdown";

// 只渲染 AI 回复。用户自己打的字保持原样输出——他打的 ** 就是想要星号，
// 把用户输入当标记解析是错的。
function inlineNodes(nodes: InlineNode[]) {
  return nodes.map((node, index) =>
    node.kind === "bold" ? (
      <strong key={`${index}-b`} className="font-semibold text-[#17243a]">{node.text}</strong>
    ) : (
      <span key={`${index}-t`}>{node.text}</span>
    ),
  );
}

export function MarkdownText({ text }: { text: string }) {
  const blocks = parseChatMarkdown(text);
  return (
    <div className="space-y-2 pt-1 text-[15px] leading-7 text-[#25364e]">
      {blocks.map((block, index) => {
        if (block.kind === "para") {
          // 段内换行仍然保留：模型有时会在一段里自己折行。
          return <p key={`${index}-p`} className="whitespace-pre-wrap">{inlineNodes(block.inline)}</p>;
        }
        const items = block.items.map((item, itemIndex) => <li key={`${itemIndex}-li`}>{inlineNodes(item)}</li>);
        return block.ordered ? (
          <ol key={`${index}-ol`} className="list-decimal space-y-1 pl-5">{items}</ol>
        ) : (
          <ul key={`${index}-ul`} className="list-disc space-y-1 pl-5">{items}</ul>
        );
      })}
    </div>
  );
}
