import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
export { getSupportedThinkingLevels };
export function modelSettings(
  models: readonly Model<any>[],
  modelId: unknown,
  requested: unknown,
  current = "high",
) {
  const model = models.find((m) => m.id === modelId);
  if (!model) throw new Error("Unavailable model");
  const levels = getSupportedThinkingLevels(model);
  const thinkingLevel =
    requested === undefined
      ? levels.includes(current as ModelThinkingLevel)
        ? current
        : levels.includes("high")
          ? "high"
          : levels[0]
      : requested;
  if (
    typeof thinkingLevel !== "string" ||
    !levels.includes(thinkingLevel as ModelThinkingLevel)
  )
    throw new Error("Unavailable reasoning level");
  return {
    model: model.id,
    thinkingLevel: thinkingLevel as ModelThinkingLevel,
  };
}
