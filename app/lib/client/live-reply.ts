export type LiveReply = {
  text: string;
  startedAt: string | null;
};

export function emptyLiveReply(): LiveReply {
  return { text: "", startedAt: null };
}

export function appendLiveReply(current: LiveReply, delta: string, arrivedAt: string): LiveReply {
  const text = current.text + delta;
  return {
    text,
    startedAt: current.startedAt ?? (text.trim() ? arrivedAt : null),
  };
}
