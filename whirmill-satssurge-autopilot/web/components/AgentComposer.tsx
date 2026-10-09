import { ComposerPrimitive, useAui } from "@assistant-ui/react";
import { useLayoutEffect } from "react";
import { ArrowUp, FlaskConical } from "lucide-react";
import { ModelPicker, type ModelCatalog } from "../../src/ui-model-picker";
import { Button } from "./ui/button";

/** Official homepage primitives/geometry, with durable admission owning submission and acknowledgement. */
export function AgentComposer({
  draft,
  setDraft,
  busy,
  pending,
  auth,
  notice,
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
  onSubmit: () => void | Promise<void>;
  onAnalysis: () => void | Promise<void>;
  onRecover: () => void | Promise<void>;
  onModelChange: (model: string, thinkingLevel?: string) => void;
}) {
  const aui = useAui();
  useLayoutEffect(() => {
    if (aui.composer().getState().text !== draft) aui.composer().setText(draft);
  }, [aui, draft]);
  return (
    <ComposerPrimitive.Root
      className="composer agent-composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && draft.trim()) void onSubmit();
      }}
    >
      <div className="composer-surface">
        <label className="sr-only" htmlFor="message">
          Messaggio al coordinatore
        </label>
        <ComposerPrimitive.Input
          id="message"
          data-composer-input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy || pending}
          placeholder="Chiedi al tuo agente…"
          rows={1}
          minRows={1}
          maxRows={8}
          autoFocus={false}
          cancelOnEscape={false}
          addAttachmentOnPaste={false}
          unstable_focusOnRunStart={false}
          unstable_focusOnScrollToBottom={false}
          unstable_focusOnThreadSwitched={false}
          unstable_insertNewlineOnTouchEnter
        />
        <div className="composer-actions">
          <div className="composer-left">
            <ModelPicker
              id="composer-model"
              auth={auth}
              disabled={busy || pending}
              onChange={onModelChange}
            />
          </div>
          <div className="composer-right">
            <Button
              variant="ghost"
              size="icon"
              className="composer-analysis"
              aria-label="Analisi in sola lettura"
              title="Analisi in sola lettura · mandato applicato dal backend"
              disabled={busy || !draft.trim() || pending}
              onClick={() => void onAnalysis()}
            >
              <FlaskConical size={17} aria-hidden="true" />
            </Button>
            <ComposerPrimitive.Send
              className="button icon-button composer-send"
              disabled={busy || !draft.trim()}
              aria-label={busy ? "Invio…" : pending ? "Riprova" : "Invia"}
              title={
                busy
                  ? "Invio…"
                  : pending
                    ? "Riprova la richiesta salvata"
                    : "Invia"
              }
              onClick={(e) => {
                e.preventDefault();
                e.currentTarget.closest("form")?.requestSubmit();
              }}
            >
              <ArrowUp size={18} aria-hidden="true" />
            </ComposerPrimitive.Send>
          </div>
        </div>
      </div>
      {pending && (
        <div className="pending">
          Richiesta salvata in attesa di conferma.
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void onRecover()}
          >
            Recupera ricevuta
          </Button>
        </div>
      )}
      {notice && (
        <p className="composer-status" role="status">
          {notice}
        </p>
      )}
    </ComposerPrimitive.Root>
  );
}
