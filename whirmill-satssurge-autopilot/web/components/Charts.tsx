import { useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  AlertCircle,
  Clock,
  Wallet,
  Shield,
} from "lucide-react";
import {
  liquidityData,
  percentOf,
  percentageLabel,
  satLabel,
  comparisonScale,
  queueDistribution,
  chartInteger,
} from "../../src/ui-chart-data";
const names: Record<string, string> = {
  queued: "In coda",
  running: "In esecuzione",
  waiting: "In attesa",
  completed: "Completate",
  failed: "Non completate",
  cancelled: "Annullate",
};
export function semanticState(state: string) {
  if (
    [
      "completed",
      "succeeded",
      "qualified",
      "verified",
      "profitable",
      "Collegato",
      "Attivo",
      "Autonomia attiva",
    ].includes(state)
  )
    return "success";
  if (["failed", "error", "negative", "rejected", "Offline"].includes(state))
    return "danger";
  if (
    [
      "queued",
      "waiting",
      "pending",
      "partial",
      "inconclusive",
      "In pausa",
    ].includes(state)
  )
    return "warning";
  if (state === "running") return "local";
  return "neutral";
}
export function MiniBadge({ state }: { state: string }) {
  const tone = semanticState(state),
    Icon =
      tone === "success"
        ? CheckCircle2
        : tone === "danger"
          ? AlertCircle
          : Clock;
  return (
    <span className={"badge tone-" + tone}>
      <Icon size={11} />
      {names[state] ?? state}
    </span>
  );
}
export function ChartBar({
  percent,
  tone = "local",
  label,
}: {
  percent: number | null;
  tone?: string;
  label: string;
}) {
  const p = percent ?? 0;
  return (
    <svg
      className="chart-bar"
      viewBox="0 0 100 8"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <rect width="100" height="8" rx="4" className="chart-track" />
      {percent !== null && (
        <rect width={p} height="8" rx="4" className={"fill-" + tone} />
      )}
    </svg>
  );
}
export function Liquidity({
  channels,
  compact = false,
}: {
  channels: any[];
  compact?: boolean;
}) {
  const [activeOnly, setActiveOnly] = useState(false),
    [sort, setSort] = useState("total");
  const data = liquidityData(channels),
    local = percentOf(data.local, data.total),
    known = data.rows.some((r) => r.total !== null),
    rows = data.rows
      .filter((r) => !activeOnly || r.active)
      .sort((a, b) => {
        if (sort === "local")
          return (b.localPercent ?? -1) - (a.localPercent ?? -1);
        const av = a.total ?? -1n,
          bv = b.total ?? -1n;
        return av === bv ? 0 : av > bv ? -1 : 1;
      });
  return (
    <div className={compact ? "liquidity compact" : "liquidity"}>
      <div className="liquidity-overview">
        <svg
          className="liquidity-donut"
          viewBox="0 0 120 120"
          role="img"
          aria-label={`Liquidità osservata: uscita ${satLabel(known ? data.local : null, false)}, ingresso ${satLabel(known ? data.remote : null, false)}`}
        >
          <title>Liquidità osservata, somma dei saldi locali e remoti</title>
          <circle
            cx="60"
            cy="60"
            r="44"
            fill="none"
            strokeWidth="13"
            className="stroke-neutral"
          />
          {data.total > 0n && (
            <>
              <circle
                cx="60"
                cy="60"
                r="44"
                fill="none"
                strokeWidth="13"
                className="stroke-remote"
              />
              <circle
                cx="60"
                cy="60"
                r="44"
                fill="none"
                strokeWidth="13"
                className="stroke-local"
                pathLength="100"
                strokeDasharray={`${local} ${100 - (local ?? 0)}`}
                transform="rotate(-90 60 60)"
              />
            </>
          )}
          <text x="60" y="57" textAnchor="middle" className="donut-number">
            {channels.length}
          </text>
          <text x="60" y="73" textAnchor="middle" className="donut-label">
            canali
          </text>
        </svg>
        <div className="liquidity-key">
          <div className="key-number tone-local">
            <ArrowUpRight size={17} />
            <span>
              Uscita · locale
              <strong>{satLabel(known ? data.local : null, false)}</strong>
            </span>
          </div>
          <div className="key-number tone-remote">
            <ArrowDownLeft size={17} />
            <span>
              Ingresso · remoto
              <strong>{satLabel(known ? data.remote : null, false)}</strong>
            </span>
          </div>
          <small>
            {data.active} attivi · {channels.length - data.active} offline
          </small>
        </div>
      </div>
      <p className="chart-note">
        Percentuali su locale + remoto.
        {data.unknown > 0
          ? ` ${data.unknown} saldi mancanti: totale parziale.`
          : ""}{" "}
        {!channels.length
          ? "Nessun canale acquisito."
          : data.total === 0n
            ? "Nessun saldo positivo osservato."
            : ""}
      </p>
      {!compact && (
        <>
          <div className="chart-controls">
            <label>
              Ordina per
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="total">Saldo totale osservato</option>
                <option value="local">Percentuale locale</option>
              </select>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={activeOnly}
                onChange={(e) => setActiveOnly(e.target.checked)}
              />
              Solo attivi
            </label>
          </div>
          <div className="channel-bars">
            {rows.map((c) => (
              <div className="channel-row" key={c.id}>
                <div className="channel-top">
                  <strong>{c.alias}</strong>
                  <MiniBadge state={c.active ? "Attivo" : "Offline"} />
                </div>
                <svg
                  viewBox="0 0 100 9"
                  preserveAspectRatio="none"
                  className="channel-balance"
                  role="img"
                  aria-label={`${c.alias}: uscita ${satLabel(c.local, false)}, ingresso ${satLabel(c.remote, false)}`}
                >
                  <title>Distribuzione su locale + remoto</title>
                  <rect width="100" height="9" rx="3" className="chart-track" />
                  {c.total !== null && c.total > 0n && (
                    <>
                      <rect
                        width={c.localPercent ?? 0}
                        height="9"
                        className="fill-local"
                      />
                      <rect
                        x={c.localPercent ?? 0}
                        width={c.remotePercent ?? 0}
                        height="9"
                        className="fill-remote"
                      />
                    </>
                  )}
                </svg>
                <div className="channel-amounts">
                  <span className="tone-local">
                    ↗ {satLabel(c.local, false)}{" "}
                    <small>{percentageLabel(c.local, c.total)}</small>
                  </span>
                  <span className="tone-remote">
                    ↙ {satLabel(c.remote, false)}{" "}
                    <small>{percentageLabel(c.remote, c.total)}</small>
                  </span>
                </div>
                <details className="channel-details">
                  <summary>Commissioni e identificativo</summary>
                  <p>
                    {c.ppm ?? "sconosciuto"} ppm + {c.baseMsat ?? "sconosciuto"}{" "}
                    msat · {c.id}
                  </p>
                  <p>
                    Capacità dichiarata · {satLabel(c.capacitySat, false)} ·
                    riserva · {satLabel(c.reserveSat, false)} · pending ·{" "}
                    {satLabel(c.pendingSat, false)}
                  </p>
                </details>
              </div>
            ))}
            {!rows.length && channels.length > 0 && (
              <p className="empty">Nessun canale per questo filtro.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
export function BudgetGauges({
  budget,
  mandate,
  compact = false,
}: {
  budget: any;
  mandate: any;
  compact?: boolean;
}) {
  const items = [
    ["Oggi", budget?.dailyMsat, mandate?.dailyMsat, "warning"],
    [
      "Esplorazione",
      budget?.exploratoryMsat,
      mandate?.exploratoryDailyMsat,
      "remote",
    ],
    ["Complessivo", budget?.cumulativeMsat, mandate?.totalMsat, "danger"],
  ];
  return (
    <div className={"budget-gauges " + (compact ? "compact" : "")}>
      {items.map(([label, value, total, tone]) => (
        <div className="gauge" key={label}>
          <div className="gauge-label">
            <strong>{label}</strong>
            <span>{percentageLabel(value, total)}</span>
          </div>
          <ChartBar
            percent={percentOf(value, total)}
            tone={tone}
            label={`${label}: ${satLabel(value)} su ${satLabel(total)}`}
          />
          <small>
            {satLabel(value)} <span>/ {satLabel(total)}</span>
          </small>
        </div>
      ))}
      {!compact && (
        <p className="protected">
          <Shield size={14} /> Riserva protetta ·{" "}
          {satLabel(mandate?.reserveSat, false)}
        </p>
      )}
    </div>
  );
}
export function AccountingChart({ pnl, label }: { pnl: any; label: string }) {
  const values = [pnl?.revenueMsat, pnl?.costMsat],
    bars = comparisonScale(values),
    net = chartInteger(pnl?.netMsat);
  return (
    <div className="accounting-chart">
      <div className="financial-bars">
        {["Ricavi", "Costi"].map((name, i) => (
          <div className="financial-row" key={name}>
            <div>
              <span className={i === 0 ? "tone-success" : "tone-danger"}>
                {i === 0 ? "↗" : "↘"} {name}
              </span>
              <strong>{satLabel(values[i])}</strong>
            </div>
            <ChartBar
              percent={bars[i]?.known ? bars[i].percent : null}
              tone={i === 0 ? "success" : "danger"}
              label={`${label}, ${name}: ${satLabel(values[i])}`}
            />
          </div>
        ))}
      </div>
      <div
        className={
          "net-summary " +
          (net === null
            ? "tone-neutral"
            : net < 0n
              ? "tone-danger"
              : "tone-success")
        }
      >
        <Wallet size={17} />
        <span>
          Risultato<strong>{satLabel(pnl?.netMsat)}</strong>
        </span>
      </div>
    </div>
  );
}
export function QueueChart({ states }: { states: any[] }) {
  const data = queueDistribution(states);
  const known = data.rows.length > 0 || states.length === 0;
  let x = 0;
  return (
    <div className="queue-visual">
      <div className="queue-total">
        <strong>{known ? data.total.toString() : "Non disponibile"}</strong>
        <span>
          {data.unknown
            ? "totale parziale osservato"
            : "attività registrate nella coda"}
        </span>
      </div>
      <svg
        className="queue-stack"
        viewBox="0 0 100 10"
        preserveAspectRatio="none"
        role="img"
        aria-label={
          data.rows
            .map((r) => `${names[r.state] ?? r.state}: ${r.count}`)
            .join(",") +
            (data.unknown
              ? `; ${data.unknown} conteggi non disponibili`
              : "") || (known ? "Coda vuota" : "Conteggi non disponibili")
        }
      >
        <title>Distribuzione degli stati della coda</title>
        <rect width="100" height="10" rx="3" className="chart-track" />
        {data.rows.map((r) => {
          const left = x;
          x += r.percent;
          return (
            <rect
              key={r.state}
              x={left}
              width={r.percent}
              height="10"
              className={"fill-" + semanticState(r.state)}
            />
          );
        })}
      </svg>
      <ul className="queue-legend">
        {data.rows.map((r) => (
          <li key={r.state}>
            <MiniBadge state={r.state} />
            <strong>{r.count.toString()}</strong>
          </li>
        ))}
      </ul>
      {data.unknown > 0 && (
        <p className="chart-note">
          Conteggi parziali · {data.unknown} valori non disponibili.
        </p>
      )}
    </div>
  );
}
export function FeeChart({ capture }: { capture: any }) {
  if (capture?.status !== "qualified")
    return (
      <p className="empty">{capture?.reason ?? "Confronto non disponibile"}</p>
    );
  return (
    <div className="fee-comparison">
      <div className="chart-legend">
        <span className="tone-local">● Nostra fee</span>
        <span className="tone-remote">● Mediana pubblica</span>
        <span>Unità · sat</span>
      </div>
      {(capture.channels ?? []).map((c: any, i: number) => (
        <article className="fee-channel" key={i}>
          <div className="row-heading">
            <h3>{c.alias}</h3>
            <MiniBadge state={c.status} />
          </div>
          {!c.quotes ? (
            <p className="muted">{c.reason ?? "Quote non disponibili"}</p>
          ) : (
            c.quotes.map((q: any, n: number) => {
              const bars = comparisonScale([q.ourFeeMsat, q.medianFeeMsat]);
              return (
                <div className="fee-quote" key={n}>
                  <div className="quote-amount">
                    Pagamento · {satLabel(q.amountSat, false)}
                  </div>
                  {["Nostra fee", "Mediana pubblica"].map((name, k) => (
                    <div className="quote-bar" key={name}>
                      <span>{name}</span>
                      <ChartBar
                        percent={bars[k]?.known ? bars[k].percent : null}
                        tone={k === 0 ? "local" : "remote"}
                        label={`${c.alias}, pagamento ${satLabel(q.amountSat, false)}, ${name} ${satLabel(k === 0 ? q.ourFeeMsat : q.medianFeeMsat)}`}
                      />
                      <strong>
                        {satLabel(k === 0 ? q.ourFeeMsat : q.medianFeeMsat)}
                      </strong>
                    </div>
                  ))}
                </div>
              );
            })
          )}
          <details className="compact-details">
            <summary>Copertura e fonte</summary>
            <p>
              Grafo · {c.capturedChannels ?? "sconosciuto"} /{" "}
              {c.graphChannelCount ?? "sconosciuto"} canali ·{" "}
              {c.missingPolicies ?? "sconosciuto"} policy mancanti ·{" "}
              {c.capturedAt ?? "data non disponibile"}
            </p>
            {c.quotes?.map((q: any, n: number) => (
              <p key={n}>
                {satLabel(q.amountSat, false)} · {q.cheaperThanUs} /{" "}
                {q.announcedEligible} prezzi inferiori al nostro
              </p>
            ))}
          </details>
        </article>
      ))}
      <p className="chart-note">
        Fonte: policy pubbliche acquisite. Copertura indicata per peer; prezzi
        annunciati, senza prova di liquidità o domanda. Ogni coppia di barre ha
        una scala propria.
      </p>
    </div>
  );
}
