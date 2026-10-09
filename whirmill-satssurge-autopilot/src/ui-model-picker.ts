import { createElement as h, useEffect, useRef, useState } from "react";
export interface ModelCatalog {
  selected?: string;
  thinkingLevel?: string;
  models?: {
    id: string;
    name: string;
    provider?: string;
    contextWindow?: number;
    thinkingLevels?: string[];
  }[];
}
export function ModelPicker({
  id,
  auth,
  disabled,
  onChange,
}: {
  id: string;
  auth: ModelCatalog | null;
  disabled: boolean;
  onChange: (model: string, thinkingLevel?: string) => void;
}) {
  const [open, setOpen] = useState(false),
    root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const models = auth?.models ?? [],
    selected = models.find((m) => m.id === auth?.selected),
    levels = selected?.thinkingLevels ?? [];
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLSelectElement>("select")?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const capacity = selected?.contextWindow;
  const shortName = selected?.id.endsWith("-sol")
    ? "Sol"
    : selected?.id.endsWith("-luna")
      ? "Luna"
      : selected?.name;
  return h(
    "div",
    { className: "composer-model", ref: root },
    h(
      "button",
      {
        type: "button",
        className: "model-trigger",
        ref: trigger,
        disabled: disabled || !models.length,
        "aria-expanded": open,
        "aria-controls": id + "-menu",
        "aria-label": `Provider ${selected?.provider ?? "non disponibile"}, modello ${selected?.name ?? "non disponibile"}, ragionamento ${auth?.thinkingLevel ?? "non disponibile"}`,
        onClick: () => setOpen(!open),
      },
      h("span", { "aria-hidden": true, title: selected?.provider }, "◈"),
      h(
        "span",
        { className: "model-name" },
        h(
          "span",
          { className: "model-full-name" },
          selected?.name ?? "Modello",
        ),
        h("span", { className: "model-short-name" }, shortName ?? "Modello"),
      ),
      h("span", { className: "model-effort" }, auth?.thinkingLevel ?? ""),
      h("span", { "aria-hidden": true }, "⌄"),
    ),
    capacity && Number.isSafeInteger(capacity) && capacity > 0
      ? h(
          "span",
          {
            className: "model-capacity",
            tabIndex: 0,
            title:
              "Capacità del catalogo provider; utilizzo corrente del contesto non disponibile.",
            "aria-label": `Capacità contesto ${capacity} token; utilizzo corrente non disponibile`,
          },
          h("span", { "aria-hidden": true }, "◷ "),
          new Intl.NumberFormat("it-IT", {
            notation: "compact",
            maximumFractionDigits: 1,
          }).format(capacity),
        )
      : null,
    open
      ? h(
          "div",
          {
            className: "model-menu",
            id: id + "-menu",
            role: "group",
            "aria-label": "Modello e ragionamento",
          },
          h("label", { htmlFor: id }, "Modello"),
          h(
            "select",
            {
              id,
              value: auth?.selected ?? "",
              disabled,
              onChange: (e: any) => onChange(e.target.value),
            },
            ...models.map((m) =>
              h("option", { key: m.id, value: m.id }, m.name),
            ),
          ),
          h("label", { htmlFor: id + "-effort" }, "Ragionamento"),
          h(
            "select",
            {
              id: id + "-effort",
              value: auth?.thinkingLevel ?? "high",
              disabled: disabled || !levels.length,
              onChange: (e: any) => onChange(auth!.selected!, e.target.value),
            },
            ...levels.map((level) =>
              h("option", { key: level, value: level }, level),
            ),
          ),
          h(
            "button",
            {
              type: "button",
              className: "model-menu-close",
              onClick: () => {
                setOpen(false);
                trigger.current?.focus();
              },
            },
            "Chiudi",
          ),
        )
      : null,
  );
}
