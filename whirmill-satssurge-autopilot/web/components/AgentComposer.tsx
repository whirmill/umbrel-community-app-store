


import { type ModelCatalog } from "../../src/ui-model-picker";
import { ModelPicker } from "./ModelPicker";


/** Official homepage primitives/geometry, with durable admission owning submission and acknowledgement. */
export function AgentComposer({
  draft,
  setDraft,
  busy,
  pending,
  auth,
  notice,
  telegram,
  onSubmit,
  onAnalysis,
  onRecover,
  onModelChange,
}: {
  draft: string;
  setDraft: (value: string) => void;
  busy: boolean;
  pending: boolean;
  auth: ModelCatalog | null;
  notice: string;
  telegram?:{paired?:boolean;username?:string};
  onSubmit: () => void | Promise<void>;
  onAnalysis: () => void | Promise<void>;
  onRecover: () => void | Promise<void>;
  onModelChange: (model: string, thinkingLevel?: string) => void;
}) {
  return <div className="composer agent-composer"><p role="status">Conversazione disponibile su Telegram. Qui puoi consultare la cronologia e gestire le impostazioni.</p><ModelPicker id="composer-model" auth={auth} disabled={busy} onChange={onModelChange} /></div>;
}
