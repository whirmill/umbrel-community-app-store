export interface ModelCatalog {
  selected?: string;
  thinkingLevel?: string;
  models?: { id: string; name: string; provider?: string; contextWindow?: number; thinkingLevels?: string[] }[];
}
const effortNames: Record<string,string> = { low: "Low", medium: "Med", high: "High", xhigh: "Xhigh", max: "Max", off: "Off", minimal: "Min" };
/** Only provider-advertised options enter the official selector; no sample catalog. */
export function modelOptions(auth: ModelCatalog | null, disabled = false) {
  return (auth?.models ?? []).map(model => ({ id: model.id, name: model.name, disabled, keywords: [model.provider ?? ""], efforts: (model.thinkingLevels ?? []).map(id => ({ id, name: effortNames[id] ?? id })), provider: model.provider }));
}
export function modelCapacity(auth: ModelCatalog | null): number | undefined {
  const value = auth?.models?.find(model => model.id === auth.selected)?.contextWindow;
  return Number.isSafeInteger(value) && value! > 0 ? value : undefined;
}
