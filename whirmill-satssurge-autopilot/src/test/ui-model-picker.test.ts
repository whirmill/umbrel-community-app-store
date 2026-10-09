import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelPicker } from "../ui-model-picker.js";
test("composer model uses authoritative selection and verified capacity without fabricated usage", () => {
  const auth = {
    selected: "sol",
    thinkingLevel: "high",
    models: [
      { id: "sol", name: "GPT Sol", provider: "openai", contextWindow: 128000 },
      { id: "other", name: "Other" },
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
  assert.match(render(), /value="sol" selected/);
  assert.match(render(), /OpenAI/);
  assert.match(render(), /Ragionamento · high/);
  assert.match(render(), /128.000 token/);
  assert.doesNotMatch(render(), /1.1M|microfono/);
  let requested = "";
  const tree = ModelPicker({
    id: "composer-model",
    auth,
    disabled: false,
    onChange: (model) => {
      requested = model;
    },
  });
  const select = (tree.props as any).children[1];
  select.props.onChange({ target: { value: "other" } });
  assert.equal(requested, "other");
  assert.equal(
    auth.selected,
    "sol",
    "failed save leaves authoritative selection unchanged",
  );
  auth.selected = "other";
  assert.match(render(), /value="other" selected/);
  assert.doesNotMatch(render(), /Capacità contesto/);
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
