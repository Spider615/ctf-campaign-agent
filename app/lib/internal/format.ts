// 管理端展示用的纯函数。上游没给的 Token 显示「未提供」，不显示 0；两个渠道各成一组，不出合计。
export type InternalChannel = "deepseek" | "juzi";
export const CHANNELS: InternalChannel[] = ["deepseek", "juzi"];
export const CHANNEL_LABEL: Record<InternalChannel, string> = { deepseek: "DeepSeek 官方", juzi: "句子互动网关" };
export const ENTRY_LABEL: Record<string, string> = { analysis: "智能问答", attachments: "文件问答", campaign: "活动创建", insight: "图谱问答" };

const TURN_STATUS: Record<string, string> = { running: "执行中", answered: "完成", partial: "答了，有保留", failed: "失败", cancelled: "已取消", interrupted: "中断" };
// 每种状态的白话说明，统计总览上悬停和下方说明都用它。
export const TURN_STATUS_HINT: Record<string, string> = {
  running: "正在回答，还没结束",
  answered: "完整回答了问题",
  partial: "给出了回答，但有一部分数据查不到或核对没通过，回答里会写明哪些地方没把握",
  failed: "没答上，客户看到的是出错提示",
  cancelled: "客户点了停止",
  interrupted: "回答到一半服务重启了，结果不完整",
};
const REQUEST_STATUS: Record<string, string> = { running: "执行中", done: "完成", error: "出错", incomplete: "不完整", interrupted: "中断" };

export const tokenText = (value: number | null | undefined) => value === null || value === undefined ? "未提供" : value.toLocaleString("en-US");
export const turnStatusText = (status: string) => TURN_STATUS[status] ?? status;
export const requestStatusText = (status: string) => REQUEST_STATUS[status] ?? status;

export function durationText(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

export function timeText(ms: number | null | undefined) {
  if (!ms) return "—";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(ms);
}

export function groupByChannel<T extends { channel: InternalChannel }>(rows: T[]): Array<{ channel: InternalChannel; rows: T[] }> {
  return CHANNELS.map((channel) => ({ channel, rows: rows.filter((row) => row.channel === channel) })).filter((group) => group.rows.length > 0);
}

// 北京时间的日期字符串，用作默认筛选范围。
export function beijingDate(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}
