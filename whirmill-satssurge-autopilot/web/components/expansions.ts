import { useState } from "react";
const values = new Map<string, boolean>();
export function useExpansion(key: string) {
  const [open, setOpen] = useState(() => values.get(key) ?? false);
  return [
    open,
    (value: boolean) => {
      values.set(key, value);
      setOpen(value);
    },
  ] as const;
}
export function pruneExpansions(jobIds: Set<string>) {
  for (const key of values.keys())
    if (!jobIds.has(key.split("|")[0]!)) values.delete(key);
}
