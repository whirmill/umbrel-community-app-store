import { useState } from 'react';
import { Button } from './ui/button';
export function TelegramSettings({ status, proposals = [], api, refresh }: {
    status: any;
    proposals: any[];
    api: (path: string, body?: unknown) => Promise<any>;
    refresh: () => Promise<any>;
}) {
    const [token, setToken] = useState(''), [pair, setPair] = useState<any>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    async function act(path: string, body: unknown = {}) { setBusy(true); setError(''); try {
        const r = await api(path, body);
        if (path === 'telegram/pairing')
            setPair(r);
        await refresh();
        return r;
    }
    catch (e: any) {
        setError(e.message);
    }
    finally {
        setBusy(false);
    } }
    return <section className="panel"><h2>Telegram</h2><p>Interfaccia quotidiana privata. Impostazioni, budget e permessi restano qui.</p><p role="status">{status?.paired ? `Collegato a ${status.owner?.username || status.owner?.userId}` : status?.configured ? 'Token configurato · account da collegare' : 'Disattivato · configura il bot'}</p><label>Token del bot<input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)}/></label><Button disabled={busy || !token} onClick={() => { const value = token; setToken(''); void act('telegram/config', { token: value }); }}>Salva token</Button><Button disabled={busy || !status?.configured} onClick={() => void act('telegram/pairing')}>Genera codice di collegamento</Button>{pair && <p>Invia <code>/start {pair.code}</code> al tuo bot entro 5 minuti. Poi conferma qui l’account identificato.</p>}{status?.candidate && <div><p>Account: {status.candidate.username || 'senza username'} · ID {status.candidate.userId}</p><Button disabled={busy} onClick={() => { setPair(undefined); void act('telegram/confirm', { userId: status.candidate.userId }); }}>Conferma questo account</Button></div>}<Button disabled={busy} onClick={() => { setPair(undefined); void act('telegram/revoke'); }}>Revoca collegamento e approvazioni pendenti</Button>{status?.error && <p role="status">{status.error}</p>}{status?.failures?.length > 0 && <p role="status">{status.failures.length} notifiche fallite o con consegna incerta. Controlla Telegram prima di ripetere manualmente.</p>}<h3>Proposte da approvare</h3>{proposals.length === 0 ? <p>Nessuna proposta. Chiedi all’agente una proposta da rivedere.</p> : proposals.map(p => <article key={p.id}><p><strong>{p.content.kind}</strong> · {p.status}</p><p>{p.content.kind === 'fee_change' ? `Canale: ${p.content.target}` : `Da ${p.content.source} a ${p.content.target}`}</p><p>Importo {p.content.amountSat} sat · costo massimo {p.content.maxFeeMsat} msat{p.content.newPpm === undefined ? '' : ` · nuova fee ${p.content.newPpm} ppm`}</p><p>{p.content.whyAct}</p><p>{p.expires_at ? `Scadenza: ${p.expires_at}` : 'In attesa di consegna Telegram; approvazione non disponibile'}</p><Button disabled={busy || p.status !== 'pending' || !p.expires_at} onClick={() => void act('proposals/approve', { id: p.id })}>Approva</Button><Button disabled={busy || p.status !== 'pending'} onClick={() => void act('proposals/reject', { id: p.id })}>Rifiuta</Button></article>)}{error && <p role="alert">{error}</p>}</section>;
}
