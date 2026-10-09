import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelPicker } from "../ui-model-picker.js";
test("closed compact composer shows authoritative model/effort and verified capacity without full-width selects or fabricated usage", () => {
  const auth = {
    selected: "gpt-6.1-sol",
    thinkingLevel: "high",
    models: [
      {
        id: "gpt-6.1-sol",
        name: "GPT Sol",
        provider: "openai",
        contextWindow: 128000,
        thinkingLevels: ["low", "high"],
      },
      { id: "other", name: "Other", thinkingLevels: ["off"] },
    ],
  };
  const render = () =>
    renderToStaticMarkup(
      createElement(ModelPicker, {
        id: "composer-model",
        auth,
        disabled: false,
        onChange: () => {},
      }),
    );
  assert.match(render(), /GPT Sol/);
  assert.match(render(), /model-short-name[^>]*>Sol/);
  assert.match(render(), /model-effort.*high/);
  assert.match(
    render(),
    /Capacità contesto 128000 token; utilizzo corrente non disponibile/,
  );
  assert.doesNotMatch(render(), /<select|<label|1.1M|microfono/);
  assert.match(render(), /aria-expanded="false"/);
  auth.selected = "other";
  auth.thinkingLevel = "off";
  assert.match(render(), /Other/);
  assert.doesNotMatch(render(), /model-capacity/);
  assert.match(
    renderToStaticMarkup(
      createElement(ModelPicker, {
        id: "empty",
        auth: null,
        disabled: false,
        onChange: () => {},
      }),
    ),
    /disabled=""/,
  );
});
