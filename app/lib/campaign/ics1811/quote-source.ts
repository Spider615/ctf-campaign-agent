// 「这个值是哪句话说的」。每条事实都存了用户原话 quote，但界面上看不到它出自哪一条消息，
// 于是填写值像是凭空出现的。这里把 quote 反查回对话里的那条用户消息，界面就能跳回去核对。
//
// 必须和 facts.ts 的 quote 守卫用同一套规范化（compactQuote），否则会出现
// 「事实记下了、却找不到出处」的自相矛盾——那比不显示出处更糟。

import { compactQuote } from "./facts.ts";
import type { ChatMessage } from "./messages.ts";

export function findQuoteSource(messages: readonly ChatMessage[], quote: string): string | null {
  // compactQuote("") 是空串，而任何字符串都 includes("")，不挡掉就会乱指一条。
  const needle = compactQuote(quote ?? "");
  if (!needle) return null;

  // 从后往前找：同一句话说过多次时，指向最近的那条。
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    // 只认用户说的话。模型的回复里会复述原话，但「谁说的」只能指向用户。
    if (message.role !== "user" || message.content.kind !== "user_text") continue;
    if (compactQuote(message.content.text).includes(needle)) return message.id;
  }
  return null;
}
