import {
  anchorAt,
  visibleRange,
  type VirtualMemory,
} from "../../src/ui-virtual-window";
// Pinned adapter: assistant-ui/react 0.15.25, core 0.3.24.
import {
  ThreadPrimitive,
  unstable_useThreadMessageIds,
} from "@assistant-ui/react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type RefObject,
} from "react";
const OVERSCAN = 4;
export function VirtualMessages({
  viewport,
  memory,
  Message,
  follow,
}: {
  viewport: HTMLDivElement | null;
  memory: VirtualMemory;
  Message: ComponentType;
  follow?: RefObject<boolean>;
}) {
  const ids = unstable_useThreadMessageIds();
  const heights = useRef(memory.heights);
  const restored = useRef(false);
  const [range, setRange] = useState({ start: 0, end: 18 });
  const [, resize] = useState(0);
  const nodes = useRef(new Map<string, HTMLElement>());
  const components = useRef({
    UserMessage: Message,
    AssistantMessage: Message,
  }).current;
  const previous = useRef<{ ids: readonly string[]; offsets: number[] } | null>(
    null,
  );
  const pendingAnchor = useRef<{ id: string; offset: number } | null>(null);
  const offsets = [0];
  for (const id of ids)
    offsets.push(offsets.at(-1)! + (heights.current.get(id) ?? 180));
  useLayoutEffect(() => {
    const el = viewport;
    if (!el) return;
    const old = previous.current;
    if (!restored.current) {
      pendingAnchor.current = memory.anchor;
      restored.current = true;
    }
    const container = el.querySelector(".virtual-messages") as HTMLElement;
    const origin = container
      ? container.getBoundingClientRect().top -
        el.getBoundingClientRect().top +
        el.scrollTop
      : 0;
    if (follow?.current) {
      el.scrollTop = el.scrollHeight;
      pendingAnchor.current = null;
    } else if (pendingAnchor.current) {
      const anchor = pendingAnchor.current,
        index = ids.indexOf(anchor.id);
      if (index >= 0) el.scrollTop = origin + offsets[index]! + anchor.offset;
      pendingAnchor.current = null;
    } else if (
      old &&
      old.ids[0] !== ids[0] &&
      el.scrollHeight - el.scrollTop - el.clientHeight > 80
    ) {
      let index = 0;
      const top = el.scrollTop - origin;
      while (index < old.ids.length - 1 && old.offsets[index + 1]! <= top)
        index++;
      const id = old.ids[index],
        next = ids.indexOf(id!);
      if (next >= 0)
        el.scrollTop = origin + offsets[next]! + (top - old.offsets[index]!);
    }
    previous.current = { ids, offsets };
  }, [viewport, ids, offsets.join(",")]);
  useLayoutEffect(() => {
    const el = viewport;
    if (!el) return;
    const update = () => {
      const container = el.querySelector(".virtual-messages") as HTMLElement;
      const origin = container
        ? container.getBoundingClientRect().top -
          el.getBoundingClientRect().top +
          el.scrollTop
        : 0;
      const top = Math.max(0, el.scrollTop - origin),
        bottom = top + el.clientHeight;
      memory.anchor = anchorAt(ids, offsets, top);
      setRange(visibleRange(offsets, top, el.clientHeight, OVERSCAN));
    };
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    update();
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [viewport, ids, offsets.join(",")]);
  useLayoutEffect(() => {
    const el = viewport;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      if (
        !follow?.current &&
        el.scrollHeight - el.scrollTop - el.clientHeight > 80
      ) {
        const rect = el.getBoundingClientRect();
        const anchor = [...nodes.current.values()]
          .filter((n) => n.getBoundingClientRect().bottom > rect.top)
          .sort(
            (a, b) =>
              a.getBoundingClientRect().top - b.getBoundingClientRect().top,
          )[0];
        if (anchor)
          pendingAnchor.current = {
            id: anchor.dataset.messageId!,
            offset: rect.top - anchor.getBoundingClientRect().top,
          };
      }
      for (const entry of entries) {
        const node = entry.target as HTMLElement,
          id = node.dataset.messageId!;
        const size =
            entry.borderBoxSize?.[0]?.blockSize ??
            node.getBoundingClientRect().height,
          old = heights.current.get(id) ?? 180;
        if (Math.abs(size - old) > 1) {
          heights.current.set(id, size);
          changed = true;
        }
      }
      if (changed) resize((n) => n + 1);
    });
    for (const node of nodes.current.values()) observer.observe(node);
    return () => observer.disconnect();
  }, [viewport, ids, range]);
  // Keep at most one focused row mounted outside the window; browser focus is never discarded.
  const focused =
    typeof document === "undefined"
      ? undefined
      : (document.activeElement?.closest("[data-message-id]") as HTMLElement)
          ?.dataset.messageId;
  const visible = ids.slice(range.start, range.end);
  if (focused && ids.includes(focused) && !visible.includes(focused))
    visible.push(focused);
  for (const key of heights.current.keys())
    if (!ids.includes(key)) heights.current.delete(key);
  return (
    <div
      className="virtual-messages"
      data-mounted-messages={visible.length}
      style={{ position: "relative", height: offsets.at(-1) }}
    >
      {visible.map((id) => {
        const i = ids.indexOf(id);
        return (
          <div
            key={id}
            data-message-id={id}
            ref={(node) => {
              if (node) nodes.current.set(id, node);
              else nodes.current.delete(id);
            }}
            style={{ position: "absolute", top: offsets[i], left: 0, right: 0 }}
          >
            <ThreadPrimitive.Unstable_MessageById
              messageId={id}
              components={components}
            />
          </div>
        );
      })}
    </div>
  );
}
