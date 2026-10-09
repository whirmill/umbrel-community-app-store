import { requestHeaders, sseFrames, type UiEvent } from "./ui-client.js";

export type StreamUpdate =
  | { type: "events"; events: UiEvent[] }
  | { type: "resync" }
  | { type: "expired" }
  | { type: "connection"; state: "connecting" | "online" | "offline" };

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
    if (signal.aborted) done();
  });
}

/** Pulling the next update acknowledges the previous projection/history merge. */
export async function* ownerEventStream(options: {
  session: string;
  signal: AbortSignal;
  cursor: () => number;
  fetch?: typeof fetch;
  reconnectMs?: number;
  maxBufferChars?: number;
}): AsyncGenerator<StreamUpdate> {
  const { signal } = options,
    fetcher = options.fetch ?? globalThis.fetch;
  while (!signal.aborted) {
    yield { type: "connection", state: "connecting" };
    try {
      const response = await fetcher("/api/events?after=" + options.cursor(), {
        credentials: "same-origin",
        headers: requestHeaders(options.session),
        signal,
      });
      if (response.status === 401) {
        await response.body?.cancel();
        yield { type: "expired" };
        return;
      }
      if (response.status === 409) {
        await response.body?.cancel();
        yield { type: "resync" };
        await delay(options.reconnectMs ?? 1800, signal);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw Error("Stream non disponibile");
      }
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", cancel);
      try {
        if (signal.aborted) break;
        yield { type: "connection", state: "online" };
        let buffer = "";
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          if (buffer.length > (options.maxBufferChars ?? 8 * 1024 * 1024))
            throw Error("Frame stream troppo grande");
          const parsed = sseFrames(buffer);
          buffer = parsed.rest;
          if (parsed.frames.length)
            yield { type: "events", events: parsed.frames };
          if (done) break;
        }
      } finally {
        signal.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch (error) {
      if (signal.aborted) return;
    }
    if (!signal.aborted) yield { type: "connection", state: "offline" };
    await delay(options.reconnectMs ?? 1800, signal);
  }
}
