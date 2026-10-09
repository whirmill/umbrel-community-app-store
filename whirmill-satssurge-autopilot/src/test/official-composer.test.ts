import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { composeEventHandlers } from "radix-ui/internal";
const source = readFileSync(
  new URL("../../web/components/AgentComposer.tsx", import.meta.url),
  "utf8",
);
const event = () => ({
  defaultPrevented: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
});
test("official Root/Send production handlers suppress runtime send/clear and route Enter or click through one durable admission", () => {
  const rootBody = source.match(/onSubmit=\{\(e\) => \{([\s\S]*?)\}\}/)?.[1],
    sendBody = source.match(/onClick=\{\(e\) => \{([\s\S]*?)\}\}/)?.[1];
  assert.ok(rootBody);
  assert.ok(sendBody);
  const root = new Function("e", "busy", "draft", "onSubmit", rootBody),
    send = new Function("e", sendBody);
  let durableCalls = 0,
    primitiveCalls = 0,
    runtimeText = "saved original request";
  const primitiveSend = () => {
    primitiveCalls++;
    runtimeText = "";
  };
  const rootHandler = composeEventHandlers(
    (e: any) =>
      root(e, false, runtimeText, () => {
        durableCalls++;
      }),
    primitiveSend,
  );
  rootHandler(event());
  assert.equal(durableCalls, 1);
  assert.equal(primitiveCalls, 0);
  assert.equal(runtimeText, "saved original request");
  const button = Object.assign(event(), {
    currentTarget: {
      closest: () => ({ requestSubmit: () => rootHandler(event()) }),
    },
  });
  composeEventHandlers((e: any) => send(e), primitiveSend)(button);
  assert.equal(durableCalls, 2);
  assert.equal(primitiveCalls, 0);
  assert.equal(runtimeText, "saved original request");
  root(event(), true, runtimeText, () => {
    durableCalls++;
  });
  root(event(), false, "  ", () => {
    durableCalls++;
  });
  assert.equal(durableCalls, 2);
  // Only acknowledged App state clears; primitives never clear an ambiguous admission.
  assert.doesNotMatch(source, /\.send\(|\.cancel\(/);
  assert.match(source, /cancelOnEscape=\{false\}/);
  assert.match(source, /addAttachmentOnPaste=\{false\}/);
});
test("official input restores runtime eligibility from App draft without sending, and is one-row autosize with no focus stealing", () => {
  const syncBody = source.match(
    /useLayoutEffect\(\(\) => \{([\s\S]*?)\}, \[aui, draft\]\);/,
  )?.[1];
  assert.ok(syncBody);
  const sync = new Function("aui", "draft", syncBody);
  let text = "",
    writes = 0;
  const client = {
    getState: () => ({ text }),
    setText: (value: string) => {
      text = value;
      writes++;
    },
  };
  const aui = { composer: () => client };
  sync(aui, "persisted pending draft");
  assert.equal(text, "persisted pending draft");
  assert.equal(writes, 1);
  sync(aui, "persisted pending draft");
  assert.equal(writes, 1);
  sync(aui, "");
  assert.equal(text, "");
  assert.equal(writes, 2);
  assert.match(source, /rows=\{1\}/);
  assert.match(source, /minRows=\{1\}/);
  assert.match(source, /maxRows=\{8\}/);
  assert.match(source, /unstable_insertNewlineOnTouchEnter/);
  for (const flag of [
    "autoFocus",
    "unstable_focusOnRunStart",
    "unstable_focusOnScrollToBottom",
    "unstable_focusOnThreadSwitched",
  ])
    assert.match(source, new RegExp(flag + "=\\{false\\}"));
  assert.doesNotMatch(source, /La chat può proporre|Mandato applicato dal/);
});
