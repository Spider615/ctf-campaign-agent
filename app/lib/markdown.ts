// 对话气泡里的极简 Markdown。放开模型表达后它会自然用 **小标题** 和分点来组织
// 四百多字的长回答，界面不渲染就会漏出满屏星号。
//
// 只认三样：加粗、有序/无序分点、段落。不支持 # 标题、表格和代码块——那是写文档的
// 排版，聊天里出现就不像人说话了（prompt.ts 里也这么要求模型，两头保持一致）。
//
// 解析成结构后由组件构造 React 元素，不走 dangerouslySetInnerHTML：模型输出里
// 混进 HTML 也只会被当字符显示。

export type InlineNode = { kind: "text"; text: string } | { kind: "bold"; text: string };

export type Block =
  | { kind: "para"; inline: InlineNode[] }
  | { kind: "list"; ordered: boolean; items: InlineNode[][] };

// 必须成对闭合、且不跨行：回复有 800 字截断，模型的话被从中间切开时会留下半个 **，
// 贪婪匹配会把后面整段正文吃掉，那比不渲染更糟。句中单个 * 同样不该被当成标记。
const BOLD = /\*\*([^*\n]+)\*\*/g;
const ORDERED = /^(\d+)[.、)]\s+(.*)$/;
const BULLET = /^[-*•]\s+(.*)$/;

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
      block.kind === "para"
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

  const flushPara = () => {
    if (!para.length) return;
    blocks.push({ kind: "para", inline: parseInline(para.join("\n")) });
    para = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    blocks.push({ kind: "list", ordered: listOrdered, items: listItems.map((item) => parseInline(item)) });
    listItems = [];
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const ordered = ORDERED.exec(line);
    const bullet = ordered ? null : BULLET.exec(line);
    if (ordered || bullet) {
      flushPara();
      const isOrdered = ordered !== null;
      // 中途从「1.」换成「-」时断成两个列表，不把两种标记混进同一组。
      if (listItems.length && listOrdered !== isOrdered) flushList();
      listOrdered = isOrdered;
      listItems.push(ordered ? ordered[2] : (bullet as RegExpExecArray)[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}
