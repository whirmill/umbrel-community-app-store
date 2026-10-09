import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LazyDisclosure } from "../ui-disclosure.js";

test("Activity/source disclosures keep payload, Markdown and nested JSON outside closed DOM across reopen", () => {
  let preparations = 0;
  const render = () => {
    preparations++;
    return createElement(
      "div",
      null,
      createElement("p", null, "PRIVATE-PAYLOAD"),
      createElement(
        "article",
        { className: "markdown" },
        "Long answer".repeat(1000),
      ),
      createElement(
        "details",
        { className: "tool" },
        createElement("pre", null, "JSON"),
      ),
    );
  };
  const markup = (open: boolean) =>
    renderToStaticMarkup(
      createElement(LazyDisclosure, {
        open,
        onToggle: () => {},
        summary: "Messaggio e attività",
        render,
      }),
    );
  for (let i = 0; i < 100; i++) {
    const closed = markup(false);
    assert.equal(
      closed,
      '<details class="compact-details"><summary>Messaggio e attività</summary></details>',
    );
    assert.doesNotMatch(closed, /PRIVATE-PAYLOAD|markdown|tool|pre>/);
  }
  assert.equal(preparations, 0);
  assert.match(markup(true), /open=""/);
  assert.equal(preparations, 1);
  assert.doesNotMatch(markup(false), /markdown|PRIVATE-PAYLOAD/);
  assert.equal(preparations, 1);
  assert.match(markup(true), /class="markdown"/);
  assert.equal(preparations, 2);
});
