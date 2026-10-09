import type { FormEvent } from "react";
import { AlertCircle, Shield, Zap } from "lucide-react";
import { Button } from "./ui/button";
import { ThemePicker } from "./Theme";

export function OwnerAccess({ checking, password, busy, error, onPassword, onSubmit, onRetry }: {
  checking: boolean;
  password: string;
  busy: boolean;
  error: string;
  onPassword: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onRetry: () => void;
}) {
  return <div className="owner-access">
    <a className="skip" href="#main">Vai al contenuto</a>
    <main id="main" className="owner-access-main" tabIndex={-1}>
      <section className="owner-access-card" aria-labelledby="access-heading">
        <div className="owner-access-identity">
          <div className="brand"><span className="logo"><Zap size={23} aria-hidden="true" /></span><span>SatsSurge<small>AUTOPILOT</small></span></div>
          <ThemePicker />
        </div>
        <span className="owner-access-eyebrow"><Shield size={15} aria-hidden="true" /> Workspace privato</span>
        <h1 id="access-heading">{checking ? "Verifica dell’accesso" : "Accedi a SatsSurge"}</h1>
        <p>{checking ? "Recupero della sessione del proprietario…" : "Accedi per parlare con il tuo agente e consultare il nodo."}</p>
        {error && <div className="notice error" role="alert"><AlertCircle size={17} aria-hidden="true" /><span>{error}</span></div>}
        {checking ? <div className="owner-access-checking">
          <p role="status">Connessione al workspace…</p>
          <Button variant="outline" disabled={busy} onClick={onRetry}>Riprova</Button>
        </div> : <form className="login-form" onSubmit={onSubmit}>
          <label htmlFor="password">Password del proprietario</label>
          <input id="password" type="password" autoComplete="current-password" required value={password} onChange={event => onPassword(event.target.value)} />
          <Button type="submit" disabled={busy}>{busy ? "Accesso…" : "Accedi"}</Button>
        </form>}
        <p className="owner-access-caption">Accesso riservato al proprietario dell’installazione.</p>
      </section>
    </main>
  </div>;
}
