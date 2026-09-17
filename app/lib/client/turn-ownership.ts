export type SessionOwner = { sessionId: string; generation: number };
export type TurnOwner = SessionOwner & { token: symbol; signal?: AbortSignal };

// 从对话组件抽出的会话归属和回合锁；每个组件实例独立持有。
export function createTurnOwnership(initialSessionId: string) {
  let session: SessionOwner = { sessionId: initialSessionId, generation: 0 };
  let active: TurnOwner | null = null;
  let mounted = true;
  const sameSession = (owner: SessionOwner) => session.sessionId === owner.sessionId && session.generation === owner.generation;
  const ownsSession = (owner: SessionOwner) => mounted && sameSession(owner);
  const ownsTurn = (owner: TurnOwner) => ownsSession(owner) && active?.token === owner.token;
  const isCurrent = (owner: SessionOwner | TurnOwner) => "token" in owner
    ? ownsTurn(owner) && !owner.signal?.aborted
    : ownsSession(owner);

  return {
    visit(sessionId: string): SessionOwner {
      if (session.sessionId !== sessionId) {
        session = { sessionId, generation: session.generation + 1 };
        active = null;
        mounted = true;
      }
      return session;
    },
    ownsSession,
    ownsTurn,
    isCurrent,
    begin(owner: SessionOwner, signal?: AbortSignal): TurnOwner | null {
      if (!ownsSession(owner) || active || signal?.aborted) return null;
      active = { ...owner, token: Symbol("turn"), signal };
      return active;
    },
    finish(owner: TurnOwner): boolean {
      if (!ownsTurn(owner)) return false;
      active = null;
      return true;
    },
    activate(owner: SessionOwner) {
      if (sameSession(owner)) mounted = true;
    },
    deactivate(owner: SessionOwner) {
      if (sameSession(owner)) {
        mounted = false;
        active = null;
      }
    },
    async readCurrent<T>(owner: SessionOwner | TurnOwner, read: () => Promise<T>, apply: (next: T) => void): Promise<T | null> {
      if (!isCurrent(owner)) return null;
      try {
        const next = await read();
        if (!isCurrent(owner)) return null;
        apply(next);
        return isCurrent(owner) ? next : null;
      } catch (error) {
        if (!isCurrent(owner)) return null;
        throw error;
      }
    },
  };
}
