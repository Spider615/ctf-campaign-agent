import type { Snapshot } from "../server/turns.ts";

function latestUserText(snapshot: Snapshot): string | null {
  for (let index = snapshot.messages.length - 1; index >= 0; index--) {
    const message = snapshot.messages[index];
    if (message.content.kind === "user_text") return message.content.text;
  }
  return null;
}

// 新会话按持久化 receipt 判断指定回合是否已提交。完全没有 receipt 的旧快照才退回末句文案判断；
// 只要快照已进入新协议，另一个回合的同文案就不能冒充当前回合。
export function turnWasCommitted(snapshot: Snapshot, clientTurnId: string, legacyText?: string): boolean {
  let hasReceipt = false;
  for (const message of snapshot.messages) {
    if (!message.content.turn) continue;
    hasReceipt = true;
    if (message.content.turn.id === clientTurnId) return true;
  }
  return !hasReceipt && legacyText !== undefined && latestUserText(snapshot) === legacyText;
}

export function reconcileSubmittedText(
  current: string,
  submitted: string,
  outcome: { committed: boolean; current: boolean },
): string {
  return outcome.current && !outcome.committed && current.length === 0 ? submitted : current;
}
