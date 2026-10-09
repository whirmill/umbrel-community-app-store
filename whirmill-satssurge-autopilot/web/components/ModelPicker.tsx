import { useEffect, useRef, useState } from "react";
import { ModelSelector } from "./vendor/assistant-ui/elements/model-selector.aui";
import { modelOptions, modelCapacity, type ModelCatalog } from "../../src/ui-model-picker";
import openaiLogo from "../assets/openai.svg";
export function ModelPicker({ id, auth, disabled, onChange }: { id: string; auth: ModelCatalog | null; disabled: boolean; onChange: (model: string, effort?: string) => void }) {
  const [open, setOpen] = useState(false);
  const trigger = () => document.getElementById(id);
  const content = () => document.getElementById(id + "-popup");
  const restore = useRef({ requested: false, sawDisabled: false });
  const rememberSelectionFocus = () => {
    restore.current = { requested: !!content()?.contains(document.activeElement), sawDisabled: false };
  };
  useEffect(() => {
    // A selection may briefly disable the Radix return-focus target while saving.
    // Explicit focus elsewhere revokes that selection's restoration intent.
    const onFocus = (event: FocusEvent) => {
      if (restore.current.requested && event.target !== document.body &&
          event.target !== trigger() && !content()?.contains(event.target as Node)) {
        restore.current.requested = false;
      }
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, [id]);
  useEffect(() => {
    if (disabled) {
      setOpen(false);
      if (restore.current.requested) restore.current.sawDisabled = true;
    } else if (restore.current.requested && restore.current.sawDisabled) {
      if (document.activeElement === document.body || document.activeElement === trigger()) {
        trigger()?.focus({ preventScroll: true });
      }
      restore.current = { requested: false, sawDisabled: false };
    }
  }, [disabled]);
  const options = modelOptions(auth, disabled).map(({provider, ...model}) => ({...model, icon: provider?.startsWith("openai") ? <img src={openaiLogo} alt="OpenAI" width={16} height={16} /> : undefined}));
  const capacity = modelCapacity(auth);
  return <div className="composer-model aui-vendor">
    <ModelSelector.Root models={options} value={auth?.selected ?? ""} effort={auth?.thinkingLevel} open={open && !disabled} onOpenChange={next => setOpen(!disabled && next)} onValueChange={model => { if (!disabled) { rememberSelectionFocus(); onChange(model); } }} onEffortChange={effort => { if (!disabled && auth?.selected) { rememberSelectionFocus(); onChange(auth.selected, effort); } }}>
      <ModelSelector.Trigger id={id} type="button" variant="ghost" size="sm" disabled={disabled || !options.length} aria-label={`Modello ${auth?.models?.find(m => m.id === auth.selected)?.name ?? "non disponibile"}, ragionamento ${auth?.thinkingLevel ?? "non disponibile"}`} className="official-model-trigger" />
      <ModelSelector.Content id={id + "-popup"} onCloseAutoFocus={event => { if (disabled && restore.current.requested) event.preventDefault(); }} side="top" align="start" searchable className="official-model-content">
        <ModelSelector.Search placeholder="Cerca modello…" aria-label="Cerca modello" />
        <ModelSelector.List><ModelSelector.Empty>Nessun modello disponibile</ModelSelector.Empty><ModelSelector.Group>{options.map(model => <ModelSelector.Item key={model.id} model={model} />)}</ModelSelector.Group></ModelSelector.List>
        <ModelSelector.Effort label="Ragionamento" />
      </ModelSelector.Content>
    </ModelSelector.Root>
    {capacity && <span className="model-capacity" tabIndex={0} title="Capacità del catalogo provider; utilizzo corrente del contesto non disponibile." aria-label={`Capacità contesto ${capacity} token; utilizzo corrente non disponibile`}>{new Intl.NumberFormat("it-IT", {notation:"compact", maximumFractionDigits:1}).format(capacity)}</span>}
  </div>;
}
