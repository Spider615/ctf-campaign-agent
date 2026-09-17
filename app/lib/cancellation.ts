export class TurnCancelledError extends Error {
  constructor(message = "已停止生成") {
    super(message);
    this.name = "AbortError";
  }
}

export function isTurnCancelled(error: unknown): boolean {
  return error instanceof TurnCancelledError ||
    (error instanceof Error && error.name === "AbortError");
}

export function throwIfTurnCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TurnCancelledError();
}

export function relayAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = () => {
    if (!target.signal.aborted) target.abort(source.reason);
  };
  source.addEventListener("abort", abort, { once: true });
  if (source.aborted) abort();
  return () => source.removeEventListener("abort", abort);
}
