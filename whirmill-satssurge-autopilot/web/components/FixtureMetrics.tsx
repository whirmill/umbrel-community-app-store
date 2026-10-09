import { useEffect, useState } from "react";
import type { AssistantRuntime } from "@assistant-ui/react";
export const fixtureCounters = {
  enabled: false,
  renders: 0,
  chunks: [] as number[],
};
function p95(samples: number[]) {
  return samples.length
    ? samples.slice().sort((a, b) => a - b)[
        Math.min(samples.length - 1, Math.floor(samples.length * 0.95))
      ]
    : null;
}
/** Enabled only by the local simulation server; values are counts/timings, never payloads. */
export function FixtureMetrics({
  enabled,
  runtime,
}: {
  enabled: boolean;
  runtime: AssistantRuntime;
}) {
  const [stats, setStats] = useState({});
  useEffect(() => {
    if (!enabled) return;
    fixtureCounters.enabled = true;
    const input: number[] = [],
      tasks: number[] = [];
    const mark = () => {
      const at = performance.now();
      requestAnimationFrame(() => {
        input.push(performance.now() - at);
        if (input.length > 512) input.shift();
      });
    };
    document.addEventListener("input", mark);
    const observer = new PerformanceObserver((list) => {
      tasks.push(...list.getEntries().map((e) => e.duration));
      if (tasks.length > 512) tasks.splice(0, tasks.length - 512);
    });
    try {
      observer.observe({ type: "longtask", buffered: true });
    } catch {}
    const timer = setInterval(() => {
      const scroll = document.querySelector(".chat-scroll");
      const anchor = [...document.querySelectorAll("[data-message-id]")].find(
        (e) =>
          e.getBoundingClientRect().bottom >
          (scroll?.getBoundingClientRect().top ?? 0),
      );
      setStats({
        nodes: document.querySelectorAll("*").length,
        mountedMessages: document.querySelectorAll(".message").length,
        visibleMessages: [
          ...document.querySelectorAll("[data-message-id]"),
        ].filter((e) => {
          const row = e.getBoundingClientRect(),
            rect = scroll?.getBoundingClientRect();
          return !!rect && row.bottom > rect.top && row.top < rect.bottom;
        }).length,
        mountedToolRows: document.querySelectorAll(".tool").length,
        closedHeavy: document.querySelectorAll(
          "details:not([open]) pre,details:not([open]) .markdown",
        ).length,
        retainedRepository: runtime.thread.export().messages.length,
        renders: fixtureCounters.renders,
        p95InputMs: p95(input),
        p95ChunkPaintMs: p95(fixtureCounters.chunks),
        longTasks: tasks.length,
        longTaskMaxMs: Math.max(0, ...tasks),
        anchorId: (anchor as HTMLElement)?.dataset.messageId,
        anchorOffset: anchor
          ? anchor.getBoundingClientRect().top -
            (scroll?.getBoundingClientRect().top ?? 0)
          : null,
      });
    }, 500);
    return () => {
      fixtureCounters.enabled = false;
      clearInterval(timer);
      observer.disconnect();
      document.removeEventListener("input", mark);
    };
  }, [enabled, runtime]);
  return enabled ? (
    <output hidden data-ui-performance={JSON.stringify(stats)} />
  ) : null;
}
