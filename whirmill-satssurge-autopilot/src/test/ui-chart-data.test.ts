import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chartInteger,
  satLabel,
  percentOf,
  percentageLabel,
  liquidityData,
  comparisonScale,
  queueDistribution,
  financialTone,
} from "../ui-chart-data.js";
test("chart amounts keep exact integers and reject unsafe or missing values rather than rendering zero", () => {
  assert.equal(chartInteger("9007199254740993003"), 9007199254740993003n);
  assert.equal(
    satLabel("9007199254740993003"),
    "9.007.199.254.740.993,003 sat",
  );
  assert.equal(
    satLabel("9007199254740993003", false),
    "9.007.199.254.740.993.003 sat",
  );
  for (const value of [
    undefined,
    null,
    "",
    NaN,
    Infinity,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    {},
    "unknown",
  ]) {
    assert.equal(chartInteger(value), null);
    assert.equal(satLabel(value), "Non disponibile");
  }
  assert.equal(satLabel(0), "0 sat");
  assert.equal(satLabel("-1500000"), "−1.500 sat");
});
test("chart ratios are finite bounded drawing coordinates with exact unclipped budget labels", () => {
  assert.equal(percentOf("9007199254740993000", "18014398509481986000"), 50);
  assert.equal(percentOf(200, 100), 100);
  assert.equal(percentageLabel(200, 100), "200,00%");
  assert.equal(percentOf(0, 100), 0);
  assert.equal(percentageLabel(0, 100), "0,00%");
  for (const [value, total] of [
    [0, 0],
    [1, 0],
    ["unknown", 100],
    [1, null],
    [-1, 100],
    [1, -1],
  ])
    assert.equal(percentOf(value, total), null);
  assert.equal(percentageLabel(1, 0), "Non disponibile");
});
test("liquidity uses local plus remote balances and keeps unknown channels out of aggregate with partial flag", () => {
  const result = liquidityData([
    {
      id: "a",
      alias: "A",
      localSat: "9007199254740993000",
      remoteSat: "9007199254740993000",
      capacitySat: "20000000000000000000",
      active: true,
    },
    { id: "b", alias: "B", localSat: "100", remoteSat: "300", active: false },
    { id: "c", localSat: "unknown", remoteSat: "50", active: false },
  ]);
  assert.equal(result.rows[0]!.localPercent, 50);
  assert.equal(result.rows[1]!.localPercent, 25);
  assert.equal(result.rows[0]!.total, 18014398509481986000n);
  assert.equal(result.rows[0]!.capacitySat, "20000000000000000000");
  assert.equal(result.local, 9007199254740993100n);
  assert.equal(result.remote, 9007199254740993300n);
  assert.equal(result.unknown, 1);
  assert.equal(result.rows[2]!.local, null);
  assert.equal(result.rows[2]!.remote, null);
  assert.equal(result.rows[2]!.localPercent, null);
  assert.equal(result.active, 1);
  const empty = liquidityData([{ localSat: 0, remoteSat: 0 }]);
  assert.equal(empty.rows[0]!.localPercent, null);
  assert.equal(empty.total, 0n);
  assert.equal(liquidityData([{ localSat: -1, remoteSat: 3 }]).unknown, 1);
});
test("fee and revenue comparisons distinguish unknown median from a known zero fee", () => {
  const result = comparisonScale(["31000", null, "0"]);
  assert.deepEqual(
    result.map((r) => r.known),
    [true, false, true],
  );
  assert.deepEqual(
    result.map((r) => r.percent),
    [100, 0, 0],
  );
  assert.deepEqual(
    comparisonScale([0, 0]).map((r) => r.percent),
    [0, 0],
  );
  assert.equal(comparisonScale(["-1"])[0]!.known, false);
  for (const row of comparisonScale([
    null,
    undefined,
    NaN,
    Infinity,
    "9007199254740993003",
  ]))
    assert.equal(Number.isFinite(row.percent), true);
});
test("queue distribution comes only from supplied valid state counts and retains unknown coverage", () => {
  const data = queueDistribution([
    { state: "running", count: "2" },
    { state: "completed", count: "6" },
    { state: "failed", count: "unknown" },
  ]);
  assert.equal(data.total, 8n);
  assert.equal(data.rows[0]!.percent, 25);
  assert.equal(data.rows[1]!.percent, 75);
  assert.equal(data.unknown, 1);
  assert.equal(queueDistribution([]).total, 0n);
  assert.equal(
    queueDistribution([{ state: "queued", count: 0 }]).rows[0]!.percent,
    0,
  );
  assert.equal(financialTone(null), "neutral");
  assert.equal(financialTone("-1"), "danger");
  assert.equal(financialTone("0"), "success");
});
