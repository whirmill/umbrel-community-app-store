import {Research} from './research.js';
import { provenance } from "./analysis-feed.js";
import { Store } from "./store.js";
export const PUBLIC_BODY_BYTES = 128 * 1024;
export function publicJob(store: Store, row: any) {
  const { run_token, lease_owner, payload_digest, ...job } = row;
  let result: any;
  try {
    result = JSON.parse(job.result ?? "{}");
  } catch {}
  if (
    typeof result?.answer === "string" &&
    Buffer.byteLength(result.answer) > PUBLIC_BODY_BYTES
  ) {
    job.result = JSON.stringify({
      ...result,
      answer: "Risposta estesa disponibile nei dettagli autenticati.",
      answerDetailAvailable: true,
      answerBytes: Buffer.byteLength(result.answer),
    });
  }
  return { ...job,...new Research(store).status(row.id), ...provenance(store, row.id) };
}

import { publicAnswer, scrub, hash, json } from "./domain.js";
export type ExchangeCollection = "chat" | "legacyChat";
function exchangeKey(exchange: any, collection: ExchangeCollection) {
  return (
    collection +
    ":" +
    hash(
      json([
        exchange.at ?? null,
        exchange.requestId ?? null,
        exchange.user ?? "",
        exchange.answer ?? "",
      ]),
    )
  );
}
export function publicExchange(exchange: any, collection: ExchangeCollection) {
  const answer = String(scrub(publicAnswer(exchange.answer))),
    bytes = Buffer.byteLength(answer);
  return {
    at: exchange.at,
    requestId: exchange.requestId,
    user: String(scrub(exchange.user ?? "")),
    answer:
      bytes > PUBLIC_BODY_BYTES
        ? "Risposta estesa disponibile nei dettagli autenticati."
        : answer,
    ...(bytes > PUBLIC_BODY_BYTES
      ? {
          answerDetailAvailable: true,
          answerDetailKey: exchangeKey(exchange, collection),
          answerBytes: bytes,
        }
      : {}),
  };
}
export function exchangeAnswerPage(store: Store, key: string, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw Error("Invalid answer cursor");
  const collection = key.split(":")[0];
  if (collection !== "chat" && collection !== "legacyChat")
    throw Error("Invalid exchange collection");
  const exchange = (store.get<any[]>(collection) ?? []).find(
    (e) => exchangeKey(e, collection) === key,
  );
  if (!exchange) return null;
  const text = Array.from(String(scrub(publicAnswer(exchange.answer))));
  return {
    text: text.slice(offset, offset + 16384).join(""),
    offset,
    total: text.length,
    nextOffset: offset + 16384 < text.length ? offset + 16384 : null,
    format:
      "exact public text page; Markdown is not parsed across partial pages",
  };
}
