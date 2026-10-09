import { Store } from "./store.js";
import { publicExchange } from "./public-job.js";
export function legacyHistory(store: Store, before?: number) {
  const length =
    store.one(
      "SELECT json_array_length(value) n FROM meta WHERE key='legacyChat'",
    )?.n ?? 0;
  const end = before ?? length;
  if (!Number.isSafeInteger(end) || end < 0 || end > length)
    throw Error("Invalid legacy history cursor");
  const rows = store.all(
    "SELECT cast(j.key AS INTEGER) legacyIndex,j.value FROM meta m,json_each(m.value) j WHERE m.key='legacyChat' AND cast(j.key AS INTEGER)<? ORDER BY cast(j.key AS INTEGER) DESC LIMIT 50",
    end,
  );
  const selected: any[] = [];
  let bytes = 0;
  for (const row of rows) {
    const entry = {
      ...publicExchange(JSON.parse(row.value), "legacyChat"),
      legacyIndex: row.legacyIndex,
    };
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (selected.length && bytes + size > 1024 * 1024) break;
    selected.push(entry);
    bytes += size;
  }
  const start = selected.at(-1)?.legacyIndex ?? end;
  return {
    legacyChat: selected.reverse(),
    nextLegacyBefore: start > 0 ? start : null,
  };
}
