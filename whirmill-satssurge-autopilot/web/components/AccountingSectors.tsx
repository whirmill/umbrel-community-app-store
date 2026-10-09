import {accountingPresentation} from '../../src/ui-research';
import {satLabel} from '../../src/ui-chart-data';
export function AccountingSectors({partition,pnl,partial}:{partition:any;pnl:any;partial:boolean}){
 const view=accountingPresentation(partition,pnl);
 return <div className="accounting-sectors">
  <p>Importi originali in satoshi. Settore e attribuzione restano distinti.</p>
  <div className="table-wrap"><table><thead><tr><th scope="col">Settore</th><th scope="col">Ricavi</th><th scope="col">Costi</th><th scope="col">Contributo contabile</th></tr></thead><tbody>
   {view.sectors.map(sector=><tr key={sector.key}><th scope="row">{sector.label}</th><td>{satLabel(sector.revenueMsat)}</td><td>{satLabel(sector.costMsat)}</td><td>{sector.key==='routing'&&!view.costAllocationComplete?'Non determinabile: costi non assegnati':satLabel(sector.netMsat)}</td></tr>)}
   <tr><th scope="row">Totale originale</th><td>{satLabel(pnl?.revenueMsat)}</td><td>{satLabel(pnl?.costMsat)}</td><td>{satLabel(pnl?.netMsat)}</td></tr>
  </tbody></table></div>
  <p className="muted">{view.reconciled?'Partizione riconciliata esattamente con il totale originale.':'Riconciliazione della partizione non disponibile.'}</p>
  <div className="sector-attribution">{view.sectors.map(sector=><div key={sector.key}><strong>{sector.label} · attribuzione dei ricavi / costi</strong><ul>{[['verified','Verificata'],['shared','Condivisa'],['unattributed','Non attribuita']].map(([key,label])=><li key={key}>{label}: {satLabel(sector.attribution?.[key!]?.revenueMsat)} / {satLabel(sector.attribution?.[key!]?.costMsat)}</li>)}</ul></div>)}</div>
  <p className="notice"><strong>Contributo routing:</strong> {view.routingContribution===null?'Non determinabile finché i costi sono non assegnati o condivisi senza allocazione.':satLabel(view.routingContribution)+' · contributo osservato, non profitto causale certificato.'} {partial?'Copertura contabile globale parziale.':'Copertura contabile globale disponibile.'} Il profitto causale non è certificato.</p>
 </div>;
}
