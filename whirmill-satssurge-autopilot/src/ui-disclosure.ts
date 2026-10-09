import { createElement, type ReactNode } from "react";

/** Native disclosure with a deferred render boundary, not hidden eager children. */
export function LazyDisclosure({
  open,
  onToggle,
  summary,
  render,
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  summary: string;
  render: () => ReactNode;
}) {
  return createElement(
    "details",
    {
      className: "compact-details",
      open,
      onToggle: (event: { currentTarget: { open: boolean } }) =>
        onToggle(event.currentTarget.open),
    },
    createElement("summary", null, summary),
    open ? render() : null,
  );
}
