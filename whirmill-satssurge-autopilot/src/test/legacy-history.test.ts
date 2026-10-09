import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.js";
import { Queue } from "../queue.js";
import { legacyHistory } from "../legacy-history.js";
import { mergeHistory, type Projection } from "../ui-client.js";
import { exchangeAnswerPage } from "../public-job.js";
test("all legacy and durable history remains pageable through bounded retained windows with stable absolute IDs", () => {
  const store = new Store(":memory:"),
    q = new Queue(store, 2000);
  const originals = Array.from({ length: 350 }, (_, i) => ({
    at: new Date(Date.parse("2026-01-01") + i * 1000).toISOString(),
    user: "Legacy " + i,
    answer: i === 349 ? "π".repeat(150000) : "Answer " + i,
  }));
  store.set("legacyChat", originals);
  for (let i = 0; i < 1000; i++) {
    const j = q.enqueue({
      requestId: "old:" + i,
      kind: "chat",
      payload: { message: "Durable " + i },
    });
    store.run("UPDATE jobs SET state='completed' WHERE id=?", j.id);
  }
  let before = Number.MAX_SAFE_INTEGER,
    legacyBefore: number | undefined = undefined,
    p: Projection = { jobs: {}, events: [], cursor: 77 };
  const seen = new Set<string>();
  let pages = 0,
    bodyKey = "";
  do {
    const jobs = store.all(
        "SELECT rowid history_id,* FROM jobs WHERE rowid<? ORDER BY rowid DESC LIMIT 50",
        before,
      ),
      legacy = legacyHistory(store, legacyBefore);
    for (const row of legacy.legacyChat) {
      assert.ok(row.legacyIndex >= 0);
      if (row.answerDetailAvailable) bodyKey = row.answerDetailKey!;
    }
    p = mergeHistory(p, { jobs, events: [], cursor: 99, ...legacy });
    for (const j of jobs) seen.add(j.id);
    for (const c of legacy.legacyChat) {
      const id = "legacy:" + c.legacyIndex;
      seen.add(id);
      assert.ok(p.jobs[id]);
      assert.equal(
        JSON.parse(p.jobs[id]!.payload!).message,
        "Legacy " + c.legacyIndex,
      );
    }
    assert.ok(Object.keys(p.jobs).length <= 250);
    assert.equal(p.cursor, 77);
    before = jobs.length === 50 ? jobs.at(-1).history_id : 1;
    legacyBefore = legacy.nextLegacyBefore ?? 0;
    pages++;
  } while (before !== 1 || legacyBefore !== 0);
  assert.equal(seen.size, 1350);
  assert.ok(pages >= 20);
  assert.deepEqual(store.get("legacyChat"), originals);
  assert.equal(store.one("SELECT sum(submitted) n FROM jobs").n, 0);
  let offset: number | null = 0,
    recovered = "";
  do {
    const page: NonNullable<ReturnType<typeof exchangeAnswerPage>> =
      exchangeAnswerPage(store, bodyKey, offset)!;
    recovered += page.text;
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(recovered, originals[349]!.answer);
  const recent = legacyHistory(store);
  p = mergeHistory(
    p,
    { jobs: q.list(50), events: [], cursor: 99, ...recent },
    true,
  );
  assert.ok(p.jobs["legacy:349"]);
  assert.ok(Object.keys(p.jobs).length <= 250);
  assert.throws(() => legacyHistory(store, -1));
  assert.throws(() => legacyHistory(store, 351));
  store.close();
});
