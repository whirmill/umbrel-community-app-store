import { useState } from 'react';
import { Button } from './ui/button';
import type { OptionalStatus, OwnerProbe } from '../../src/optional-integration-control';
const probes: readonly [OwnerProbe, string][] = [['robosats-info', 'Info RoboSats'], ['robosats-book', 'Book RoboSats'], ['magma-estimate', 'Stima Magma'], ['magma-offers', 'Offerte Magma'], ['space-availability', 'Disponibilità Amboss Space'], ['magma-account-auth', 'Verifica chiave esistente (Magma)']];
export function OptionalIntegrationSettings({ status, api, refresh }: { status?: OptionalStatus; api: (path: string, body?: unknown) => Promise<any>; refresh: () => Promise<any> }) {
  const [ambossKey, setAmbossKey] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const flags = status?.flags ?? { robosats: false, ambossSpace: false, magma: false };
  async function act(path: string, body: unknown) {
    setBusy(true); setMessage('');
    try { const r = await api(path, body); setMessage(r.ok === false ? `Operazione bloccata: ${['unauthorized', 'storage_unavailable', 'roadmap_blocked', 'unsupported', 'disabled', 'cooldown', 'credential_missing', 'schema', 'http', 'timeout', 'invalid_config'].includes(r.reason) ? r.reason : 'non disponibile'}` : path.endsWith('config') ? 'Configurazione salvata' : r.result?.ok === false ? 'Probe non qualificato; nessun effetto finanziario' : 'Probe completato; nessuna operazione finanziaria'); await refresh(); }
    catch { setMessage('Operazione non riuscita. Nessuna credenziale viene mostrata nella risposta.'); }
    finally { setBusy(false); }
  }
  return <section className="panel"><h2>Integrazioni opzionali</h2><p>Solo letture. Trade, swap, canali, leasing e sottoscrizioni non sono disponibili.</p><p role="status">{status?.runtimeReady ? 'Gate di roadmap completati' : 'Letture sospese fino al completamento core → M2.4 → M3 → M4'} · {status?.ambossKeyConfigured ? 'Chiave Amboss presente; autenticazione live da verificare' : 'Chiave Amboss assente'}</p>
    <fieldset disabled={busy || !status?.storageAvailable}><legend>Abilitazioni di lettura</legend>{(['robosats', 'ambossSpace', 'magma'] as const).map(flag => <label key={flag}><input type="checkbox" checked={flags[flag]} onChange={e => void act('optional-integrations/config', { flags: { ...flags, [flag]: e.target.checked } })}/>{flag === 'ambossSpace' ? 'Amboss Space' : flag === 'robosats' ? 'RoboSats' : 'Magma'}</label>)}
      <label>Chiave API Amboss già esistente<input type="password" autoComplete="off" value={ambossKey} maxLength={4096} onChange={e => setAmbossKey(e.target.value)}/></label><Button disabled={!ambossKey} onClick={() => { const value = ambossKey; setAmbossKey(''); void act('optional-integrations/config', { flags, ambossKey: value }); }}>Salva chiave esistente</Button><Button disabled={!status?.ambossKeyConfigured} onClick={() => { setAmbossKey(''); void act('optional-integrations/config', { flags, clearAmbossKey: true }); }}>Rimuovi chiave</Button>
    </fieldset><fieldset disabled={busy || !status?.runtimeReady || !status?.storageAvailable}><legend>Probe read-only</legend>{probes.map(([probe, label]) => <Button key={probe} onClick={() => void act('optional-integrations/probe', { probe })}>{label}</Button>)}</fieldset><p>Offerte e unità fee Magma restano non qualificate. La chiave non crea una sottoscrizione né autorizza operazioni.</p>{message && <p role="status">{message}</p>}</section>;
}
