import { createElement as h } from "react";
export interface ModelCatalog {
  selected?: string;
  thinkingLevel?: string;
  models?: {
    id: string;
    name: string;
    provider?: string;
    contextWindow?: number;
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
  onChange: (model: string) => void;
}) {
  const models = auth?.models ?? [],
    selected = models.find((m) => m.id === auth?.selected);
  return h(
    "div",
    { className: "composer-model" },
    h(
      "label",
      { htmlFor: id },
      h("span", { "aria-hidden": true }, "◈"),
      "Modello",
    ),
    h(
      "select",
      {
        id,
        value: auth?.selected ?? "",
        disabled: disabled || !models.length,
        onChange: (event: any) => onChange(event.target.value),
      },
      h("option", { value: "", disabled: true }, "Seleziona modello"),
      ...models.map((m) => h("option", { key: m.id, value: m.id }, m.name)),
    ),
    h(
      "span",
      { className: "model-metadata" },
      h(
        "span",
        null,
        selected?.provider === "openai"
          ? "OpenAI"
          : (selected?.provider ?? "Provider non disponibile"),
      ),
      h(
        "span",
        null,
        `Ragionamento · ${auth?.thinkingLevel ?? "non disponibile"}`,
      ),
      selected?.contextWindow &&
        Number.isSafeInteger(selected.contextWindow) &&
        selected.contextWindow > 0
        ? h(
            "span",
            {
              title:
                "Capacità dichiarata dal catalogo del provider; non indica il consumo corrente.",
            },
            `Capacità contesto · ${selected.contextWindow.toLocaleString("it-IT")} token`,
          )
        : null,
    ),
  );
}
