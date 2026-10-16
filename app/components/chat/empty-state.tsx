"use client";

import { HistoryConversation } from "../analytics/history-conversation";

// 旧入口沿用统一对话，不再要求用户先选分析或活动执行。
export function EmptyState() {
  return <HistoryConversation />;
}
