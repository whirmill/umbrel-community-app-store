export function summaryPrefix(text: string) {
  const b = Buffer.from(text);
  if (b.length <= 24000) return text;
  let end = 24000;
  while ((b[end]! & 0xc0) === 0x80) end--;
  return b.subarray(0, end).toString("utf8");
}
/** Responses-only public summary allowlist. Raw thinking/content/signatures never leave this module. */
export function responseSummaries(signature: unknown) {
  if (typeof signature !== "string" || signature.length > 2 * 1024 * 1024)
    return [];
  try {
    const item = JSON.parse(signature);
    if (
      item?.type !== "reasoning" ||
      typeof item.id !== "string" ||
      !Array.isArray(item.summary)
    )
      return [];
    return item.summary.flatMap((s: any, index: number) =>
      s?.type === "summary_text" && typeof s.text === "string" && s.text
        ? [
            {
              itemId: item.id,
              index,
              text: summaryPrefix(s.text),
              truncated: Buffer.byteLength(s.text) > 24000,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}
export function summaryDelta(event: any, api: string) {
  return api === "openai-responses" &&
    event?.type === "response.reasoning_summary_text.delta" &&
    typeof event.item_id === "string" &&
    Number.isSafeInteger(event.summary_index) &&
    event.summary_index >= 0 &&
    Number.isSafeInteger(event.sequence_number) &&
    typeof event.delta === "string"
    ? {
        itemId: event.item_id,
        index: event.summary_index,
        sequence: event.sequence_number,
        delta: event.delta,
      }
    : null;
}
