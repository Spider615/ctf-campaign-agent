import { parseChatMarkdown, type Block } from "../../markdown.ts";

// v4 正文的 Markdown 和数字引用一起解析。
// refs 给的是原文字符区间，而 parseChatMarkdown 会去掉 **、列表前缀、标题井号，位置对不上；
// 所以先把每个引用区间换成一个私用区占位字符，解析完再在文本节点里把占位字符还原成数字。
// 私用区字符不会出现在正文里（解析前先清掉），占位字符也不是空白，不会被 trim 或改变行结构。

export type BodyPart = { kind: "text"; text: string } | { kind: "ref"; index: number; text: string; factIds: string[] };
export type BodyInline = { bold: boolean; parts: BodyPart[] };
export type BodyMarkdownBlock =
  | { kind: "para"; inline: BodyInline[] }
  | { kind: "heading"; level: number; inline: BodyInline[] }
  | { kind: "list"; ordered: boolean; items: BodyInline[][] };

type Ref = { start: number; end: number; factIds: string[] };

const PRIVATE_BASE = 0xe000;
const PRIVATE_LIMIT = 0xf8ff - PRIVATE_BASE;
const PRIVATE_USE = /[-]/g;

export function parseBodyMarkdown(text: string, refs: readonly Ref[]): BodyMarkdownBlock[] {
  // 按起点排序，区间越界或和前一个重叠的引用跳过（校验已挡过，这里只是不让渲染出错）。
  const ordered = [...refs].sort((a, b) => a.start - b.start);
  const kept: Ref[] = []; let cursor = 0;
  for (const ref of ordered) {
    if (ref.start < cursor || ref.end <= ref.start || ref.end > text.length || kept.length >= PRIVATE_LIMIT) continue;
    kept.push(ref); cursor = ref.end;
  }
  let source = ""; let last = 0;
  kept.forEach((ref, index) => {
    // 区间里带着的 ** 挪到占位字符外面（开头的放前面，其余放后面），加粗仍能成对，数字本身不进加粗嵌套。
    const span = text.slice(ref.start, ref.end);
    const lead = /^(?:\*\*)*/.exec(span)![0];
    const trail = "**".repeat((span.slice(lead.length).match(/\*\*/g) ?? []).length);
    source += text.slice(last, ref.start).replace(PRIVATE_USE, "") + lead + String.fromCharCode(PRIVATE_BASE + index) + trail;
    last = ref.end;
  });
  source += text.slice(last).replace(PRIVATE_USE, "");
  // 数字区间跨过加粗标记时以 refs 为准：按钮里显示去掉标记后的数字，不渲染成嵌套。
  const shown = kept.map((ref) => text.slice(ref.start, ref.end).replace(/\*\*/g, "").replace(PRIVATE_USE, ""));
  const parts = (value: string): BodyPart[] => {
    const result: BodyPart[] = []; let buffer = "";
    for (const char of value) {
      const code = char.charCodeAt(0) - PRIVATE_BASE;
      if (char.length === 1 && code >= 0 && code < kept.length) {
        if (buffer) { result.push({ kind: "text", text: buffer }); buffer = ""; }
        result.push({ kind: "ref", index: code, text: shown[code], factIds: [...kept[code].factIds] });
      } else buffer += char;
    }
    if (buffer) result.push({ kind: "text", text: buffer });
    return result;
  };
  const inline = (nodes: Extract<Block, { kind: "para" }>["inline"]): BodyInline[] => nodes.map((node) => ({ bold: node.kind === "bold", parts: parts(node.text) })).filter((node) => node.parts.length);
  return parseChatMarkdown(source).map((block): BodyMarkdownBlock => block.kind === "list"
    ? { kind: "list", ordered: block.ordered, items: block.items.map(inline) }
    : block.kind === "heading" ? { kind: "heading", level: block.level, inline: inline(block.inline) } : { kind: "para", inline: inline(block.inline) });
}
