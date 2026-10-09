import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorAt, visibleRange, virtualMemory } from "../ui-virtual-window.js";
test("re-attached viewport recomputes intersecting messages at restored recent and history positions", () => {
  const offsets = Array.from({ length: 501 }, (_, i) => i * 180);
  for (const top of [29567.5, 0, 12450, 88000]) {
    const range = visibleRange(offsets, top, 392);
    const mounted = Array.from(
      { length: range.end - range.start },
      (_, i) => range.start + i,
    );
    assert.ok(
      mounted.some((i) => offsets[i]! < top + 392 && offsets[i + 1]! > top),
    );
    assert.ok(mounted.length <= 12);
  }
  assert.ok(visibleRange(offsets, 29567.5, 392).start > 150);
});
test("retained variable heights and ID-offset history anchor survive remount, resize and prepending", () => {
  const memory = virtualMemory(),
    ids = ["a", "b", "c", "d"];
  for (const [id, height] of [
    ["a", 900],
    ["b", 1800],
    ["c", 120],
    ["d", 600],
  ] as const)
    memory.heights.set(id, height);
  const offsets = [0];
  for (const id of ids) offsets.push(offsets.at(-1)! + memory.heights.get(id)!);
  memory.anchor = anchorAt(ids, offsets, 1100);
  assert.deepEqual(memory.anchor, { id: "b", offset: 200 });
  const restoredIds = ["older", ...ids],
    restored = [0, 350];
  for (const id of ids)
    restored.push(restored.at(-1)! + memory.heights.get(id)!);
  const top =
    restored[restoredIds.indexOf(memory.anchor!.id)]! + memory.anchor!.offset;
  assert.equal(top, 1450);
  assert.deepEqual(anchorAt(restoredIds, restored, top), memory.anchor);
  for (const height of [180, 392, 844]) {
    const range = visibleRange(restored, top, height);
    assert.ok(range.start <= 2 && range.end > 2);
  }
  assert.equal(memory.heights.get("b"), 1800);
});

test("the actual section navigation handler preserves manual history follow mode and ID-offset anchor", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../../web/App.tsx", import.meta.url).pathname.replace(
      "/dist/web/",
      "/web/",
    ),
    "utf8",
  );
  const nav = source.slice(
    source.indexOf('<nav aria-label="Navigazione principale">'),
    source.indexOf(
      "</nav>",
      source.indexOf('<nav aria-label="Navigazione principale">'),
    ),
  );
  const body = nav.match(/onClick=\{\(\) => \{([\s\S]*?)\}\}/)?.[1];
  assert.ok(body, "qualify the production navigation callback");
  const navigate = new Function("setTab", "id", "follow", body);
  const memory = virtualMemory(),
    follow = { current: false };
  memory.anchor = { id: "legacy:300:assistant", offset: 54.234375 };
  const original = { ...memory.anchor };
  let tab = "chat";
  for (const id of ["activity", "chat", "node", "chat"])
    navigate(
      (value: string) => {
        tab = value;
      },
      id,
      follow,
    );
  assert.equal(tab, "chat");
  assert.equal(follow.current, false);
  assert.deepEqual(memory.anchor, original);
  const ids = [
    "legacy:299:assistant",
    "legacy:300:user",
    "legacy:300:assistant",
    "legacy:301:user",
  ];
  const offsets = [0, 200, 350, 800, 1100],
    top = offsets[ids.indexOf(memory.anchor.id)]! + memory.anchor.offset;
  assert.deepEqual(anchorAt(ids, offsets, top), original);
  assert.ok(visibleRange(offsets, top, 392).end > 2);
  follow.current = true;
  navigate(() => {}, "chat", follow);
  assert.equal(follow.current, true);
});
