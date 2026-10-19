// 对话气泡里的极简 Markdown。放开模型表达后它会自然用 **小标题** 和分点来组织
// 四百多字的长回答，界面不渲染就会漏出满屏星号。
//
// 支持标题、加粗、有序/无序分点和段落，长回答可以保留内容层次。
// 数据对比表由已核验的结构化证据渲染，不让模型用 Markdown 表格补经营数字。
//
// 解析成结构后由组件构造 React 元素，不走 dangerouslySetInnerHTML：模型输出里
// 混进 HTML 也只会被当字符显示。

export type InlineNode = { kind: "text"; text: string } | { kind: "bold"; text: string };

export type Block =
  | { kind: "para"; inline: InlineNode[] }
  | { kind: "heading"; level: number; inline: InlineNode[] }
  | { kind: "list"; ordered: boolean; items: InlineNode[][]; start?: number };

// 必须成对闭合、且不跨行：回复有 800 字截断，模型的话被从中间切开时会留下半个 **，
// 贪婪匹配会把后面整段正文吃掉，那比不渲染更糟。句中单个 * 同样不该被当成标记。
const BOLD = /\*\*([^*\n]+)\*\*/g;
const ORDERED = /^(\d+)[.、)]\s+(.*)$/;
const BULLET = /^[-*•]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.+)$/;

export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let last = 0;
  for (const match of text.matchAll(BOLD)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push({ kind: "text", text: text.slice(last, start) });
    nodes.push({ kind: "bold", text: match[1] });
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push({ kind: "text", text: text.slice(last) });
  return nodes.length ? nodes : [{ kind: "text", text }];
}

// 去掉标记、保留结构的纯文本。两个地方要用：复制按钮（贴进微信或 OA 不该带星号），
// 以及对外宣传文案（那是要发出去的东西，源头就不该有标记）。
// 注意不要在 messageToText 里做这件事——那份文本同时喂给模型当历史上下文，
// 在那里剥离会让模型看到的历史和它自己说过的话对不上。
export function plainText(text: string): string {
  return parseChatMarkdown(text)
    .map((block) =>
      block.kind !== "list"
        ? block.inline.map((node) => node.text).join("")
        : block.items
            .map((item, index) => `${block.ordered ? `${index + 1}. ` : "· "}${item.map((node) => node.text).join("")}`)
            .join("\n"),
    )
    .join("\n");
}

export function parseChatMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let listItems: string[] = [];
  let listOrdered = false;
  let listStart = 1;
  // 列表项之间隔着空行（模型常这样写「1. …\n\n2. …」）仍算同一个列表；只在空行后接的不是同类列表项时才结束。
  let blankAfterList = false;

  const flushPara = () => {
    if (!para.length) return;
    blocks.push({ kind: "para", inline: parseInline(para.join("\n")) });
    para = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    blocks.push({ kind: "list", ordered: listOrdered, items: listItems.map((item) => parseInline(item)), ...(listOrdered && listStart !== 1 ? { start: listStart } : {}) });
    listItems = [];
    blankAfterList = false;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      if (listItems.length) blankAfterList = true;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      blankAfterList = false;
      flushList();
      blocks.push({ kind: "heading", level: heading[1].length, inline: parseInline(heading[2]) });
      continue;
    }
    const ordered = ORDERED.exec(line);
    const bullet = ordered ? null : BULLET.exec(line);
    if (ordered || bullet) {
      flushPara();
      const isOrdered = ordered !== null;
      // 中途从「1.」换成「-」时断成两个列表，不把两种标记混进同一组。
      if (listItems.length && listOrdered !== isOrdered) flushList();
      // 有序列表保留模型写的起始编号：中间被段落隔开后接着写「3.」，不能重新从 1 开始。
      if (!listItems.length && ordered) listStart = Number(ordered[1]) || 1;
      listOrdered = isOrdered;
      blankAfterList = false;
      listItems.push(ordered ? ordered[2] : (bullet as RegExpExecArray)[1]);
      continue;
    }
    // 列表项紧跟着的非列表行（没有空行）是这一项的续行；隔了空行就是新段落。
    if (listItems.length && !blankAfterList) { listItems[listItems.length - 1] += `\n${line}`; continue; }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}
