export type VirtualMemory = {
  heights: Map<string, number>;
  anchor: { id: string; offset: number } | null;
};
export function virtualMemory(): VirtualMemory {
  return { heights: new Map(), anchor: null };
}
/** Derive from the attached viewport's current geometry, never a stale initial range. */
export function visibleRange(
  offsets: readonly number[],
  top: number,
  height: number,
  overscan = 4,
) {
  const count = offsets.length - 1;
  let start = 0,
    end = 0;
  while (start < count && offsets[start + 1]! < top) start++;
  end = start;
  while (end < count && offsets[end]! < top + height) end++;
  return {
    start: Math.max(0, start - overscan),
    end: Math.min(count, end + overscan),
  };
}
export function anchorAt(
  ids: readonly string[],
  offsets: readonly number[],
  top: number,
) {
  let index = 0;
  while (index < ids.length - 1 && offsets[index + 1]! <= top) index++;
  return ids[index] ? { id: ids[index]!, offset: top - offsets[index]! } : null;
}
