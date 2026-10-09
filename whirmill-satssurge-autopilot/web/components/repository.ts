import {
  fromThreadMessageLike,
  type ThreadMessageLike,
  type ThreadMessage,
  type ExportedMessageRepository,
} from "@assistant-ui/react";
/** Pinned replacement repository: reuses immutable message objects, prunes IDs absent from current window. */
export function repositoryFor(
  messages: readonly ThreadMessageLike[],
  cache: WeakMap<object, ThreadMessage>,
): ExportedMessageRepository {
  return {
    headId: messages.at(-1)?.id ?? null,
    messages: messages.map((m, i) => {
      let message = cache.get(m);
      if (!message) {
        message = fromThreadMessageLike(m, m.id ?? "missing-id", {
          type: "complete",
          reason: "stop",
        });
        cache.set(m, message);
      }
      return { message, parentId: messages[i - 1]?.id ?? null };
    }),
  };
}
