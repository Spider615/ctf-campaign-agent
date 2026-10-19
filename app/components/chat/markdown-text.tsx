"use client";

import type { ReactNode } from "react";
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

export function MarkdownText({ text, trailing }: { text: string; trailing?: ReactNode }) {
  const blocks = parseChatMarkdown(text);
  return (
    <div className="min-w-0 cursor-text select-text space-y-3 break-words pt-1 text-[15px] leading-7 text-foreground">
      {blocks.map((block, index) => {
        const suffix = index === blocks.length - 1 ? trailing : null;
        if (block.kind === "para") {
          // 段内换行仍然保留：模型有时会在一段里自己折行。
          return <p key={`${index}-p`} className="whitespace-pre-wrap">{inlineNodes(block.inline)}{suffix}</p>;
        }
        if (block.kind === "heading") {
          const Heading = block.level <= 2 ? "h2" : block.level === 3 ? "h3" : "h4";
          return <Heading key={`${index}-h`} className={`pt-2 font-semibold tracking-tight first:pt-0 ${block.level <= 2 ? "text-[18px]" : "text-base"}`}>{inlineNodes(block.inline)}{suffix}</Heading>;
        }
        const items = block.items.map((item, itemIndex) => <li key={`${itemIndex}-li`} className="whitespace-pre-wrap pl-1">{inlineNodes(item)}{itemIndex === block.items.length - 1 ? suffix : null}</li>);
        return block.ordered ? (
          <ol key={`${index}-ol`} start={block.start} className="list-decimal space-y-1 pl-5">{items}</ol>
        ) : (
          <ul key={`${index}-ul`} className="list-disc space-y-1 pl-5">{items}</ul>
        );
      })}
    </div>
  );
}
