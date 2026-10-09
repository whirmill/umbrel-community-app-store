import { test } from "node:test";
import assert from "node:assert/strict";
import {
  modelSettings,
  getSupportedThinkingLevels,
} from "../model-settings.js";
const model: any = {
  id: "sol",
  reasoning: true,
  thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: null },
};
test("model and effort validation honors actual SDK capabilities and rejects without altering authoritative setting", () => {
  assert.deepEqual(getSupportedThinkingLevels(model), [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(modelSettings([model], "sol", "low"), {
    model: "sol",
    thinkingLevel: "low",
  });
  assert.deepEqual(modelSettings([model], "sol", undefined), {
    model: "sol",
    thinkingLevel: "high",
  });
  for (const level of ["max", "minimal", "garbage", 1])
    assert.throws(() => modelSettings([model], "sol", level), /reasoning/);
  assert.throws(() => modelSettings([model], "missing", "high"), /model/);
  const plain = { ...model, id: "plain", reasoning: false };
  assert.deepEqual(modelSettings([plain], "plain", undefined), {
    model: "plain",
    thinkingLevel: "off",
  });
});
