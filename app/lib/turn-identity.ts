// 回合身份属于传输与持久化协议，不参与 Campaign/1811 事实推导。
export type TurnReceipt = { id: string; requestHash: string };
export type ClientTurnBody =
  | { type: "text"; text: string }
  | { type: "edit"; answers?: Record<string, unknown>; copy?: { name?: string; content?: string }; origin: "panel" | "tool" }
  | { type: "interpret" }
  | { type: "dismiss"; noteId: string }
  | { type: "undo"; versionSeq: number }
  | { type: "rollback"; seq: number };

type LeaseBody = ClientTurnBody & { expectedSeq?: number; clientTurnId?: string };

export function isClientTurnId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function turnMessageId(sessionId: string, clientTurnId: string): string {
  return `turn:${encodeURIComponent(sessionId)}:${clientTurnId}`;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function turnBodyKey(body: object): string {
  // 对账后版本号可刷新；回合身份仍绑定同一个受控操作，不能移给另一句原话或另一组字段。
  return JSON.stringify(canonical(Object.fromEntries(Object.entries(body).filter(([key]) => key !== "expectedSeq" && key !== "clientTurnId"))));
}

// 客户端只保留一个尚未确定结果的受控回合。相同操作重试沿用身份；换操作或确认完成后才换新身份。
export function createClientTurnLease(createId: () => string = () => crypto.randomUUID()) {
  let current: { bodyKey: string; id: string } | null = null;
  return {
    acquire(body: LeaseBody): string {
      const bodyKey = turnBodyKey(body);
      if (current?.bodyKey === bodyKey) return current.id;
      current = { bodyKey, id: createId() };
      return current.id;
    },
    complete(id: string): boolean {
      if (current?.id !== id) return false;
      current = null;
      return true;
    },
  };
}

export async function turnRequestHash(body: object): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(turnBodyKey(body)));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
