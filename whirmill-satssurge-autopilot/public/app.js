let csrf='',busy=false,pendingSubmission=null;const $=id=>document.getElementById(id);const sats=m=>{const n=BigInt(m),v=n<0n?-n:n,f=(v%1000n).toString().padStart(3,'0').replace(/0+$/,'');return (n<0n?'−':'')+new Intl.NumberFormat('it-IT',{useGrouping:'always'}).format(v/1000n)+(f?','+f:'');};const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let ownerSession=sessionStorage.getItem('satssurge.ownerSession')??'';
async function api(path,body){
  const requestSession=ownerSession,headers={'Authorization':'Bearer '+requestSession};
  if(body){headers['Content-Type']='application/json';headers['X-CSRF-Token']=csrf;}
  const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers,credentials:'same-origin',...(body?{body:JSON.stringify(body)}:{})});
  const data=await r.json();
  if(r.status===401&&ownerSession===requestSession){ownerSession='';sessionStorage.removeItem('satssurge.ownerSession');$('owner-panel').hidden=false;}
  if(!r.ok)throw new Error(data.error??'Request failed');return data;
}
async function refresh(){try{const s=await api('status');csrf=s.csrf;$('owner-panel').hidden=true;$('connection').textContent=s.enabled?'Autonomia abilitata':'In pausa';$('blockers').innerHTML=s.blockers.map(x=>'<div class="notice">'+esc(x)+'</div>').join('');$('metrics').innerHTML=[['Ricavi riconciliati · 30 giorni',sats(s.pnl30.revenueMsat)+' sat'],['Costi · 30 giorni',sats(s.pnl30.costMsat)+' sat'],['Risultato '+(s.partial?'parziale':'netto'),sats(s.pnl30.netMsat)+' sat'],['Budget residuo',sats(s.budget.remainingMsat)+' sat']].map(([l,v])=>'<div class="metric"><span>'+esc(l)+'</span><strong>'+esc(v)+'</strong></div>').join('');$('budget').textContent='Oggi: '+sats(s.budget.dailyMsat)+' / 1.500 sat · esplorazione '+sats(s.budget.exploratoryMsat)+' / 750 sat. Riserva protetta: 500.000 sat.';$('channels').innerHTML=(s.snapshot?.channels??[]).map(c=>'<tr><td>'+esc(c.alias)+'</td><td>'+esc(c.localSat)+' / '+esc(c.remoteSat)+' sat</td><td>'+esc(c.ppm)+' ppm + '+esc(c.baseMsat)+' msat</td><td>'+(c.active?'Attivo':'Offline')+'</td></tr>').join('');$('decisions').innerHTML=s.decisions.length?s.decisions.map(d=>'<div class="decision"><strong>'+esc(d.proposal.problem)+'</strong><p>'+esc(d.proposal.whyAct)+'</p><p>'+esc(d.proposal.evidence)+'</p><p>Ipotesi: '+esc(d.proposal.hypothesis)+' · verifica: '+esc(d.proposal.verify)+'</p><small>'+esc(d.at)+' · '+esc(d.status)+' · massimo '+sats(d.proposal.maxFeeMsat)+' sat · beneficio '+sats(d.forecast.benefitMsat)+' sat</small></div>').join(''):'Nessun intervento. Attesa di autenticazione ed evidenze qualificate.';$('coverage').textContent=JSON.stringify({collector:s.collector,diagnostics:s.diagnostics?Object.fromEntries(Object.entries(s.diagnostics).filter(([k])=>k!=='at').map(([k,v])=>[k,{status:v.status,version:v.version,capturedAt:v.capturedAt,coverage:v.coverage}])):null,coverage:s.coverage,import:{at:s.importReport?.at,documents:s.importReport?.files?.length,ledgerEntries:s.importReport?.ledgerEntriesRead,problems:s.importReport?.problems,coverageComplete:s.importReport?.coverageComplete},partialAccounting:s.partial},null,2);$('chat').textContent=s.chat.map(c=>c.user+'\n'+c.answer).join('\n\n');renderJobs(s);renderEvaluations(s);renderDiagnostics(s);renderCompetition(s);await authRefresh();}catch(e){$('connection').textContent=e.message;}}
async function authRefresh(){const a=await api('auth');$('thinking-level').textContent='Ragionamento: '+a.thinkingLevel;$('login').disabled=a.busy;$('model').innerHTML=(a.models??[]).map(m=>'<option value="'+esc(m.id)+'" '+(m.id===a.selected?'selected':'')+'>'+esc(m.name)+'</option>').join('');$('auth').replaceChildren();for(const e of a.events??[]){const p=document.createElement('p');p.textContent=e.message??e.instructions??e.userCode??'';if(e.type==='auth_url'||e.type==='device_code'){const link=document.createElement('a');link.href=e.url??e.verificationUri;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Apri accesso sicuro';p.append(' ',link);}$('auth').append(p);}$('auth-form').hidden=!a.prompt;if(a.prompt)$('auth-label').textContent=a.prompt.message;}
$('pause').onclick=async()=>{await api('pause',{});await refresh();};$('resume').onclick=async()=>{try{await api('resume',{});await refresh();}catch(e){alert(e.message);}};$('login').onclick=async()=>{await api('auth/start',{});await authRefresh();};$('model').onchange=async()=>{await api('model',{model:$('model').value});};$('auth-form').onsubmit=async e=>{e.preventDefault();await api('auth/respond',{value:$('auth-response').value});$('auth-response').value='';};function requestId(){const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return 'owner:'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
async function submitMessage(kind){
  if(busy)return;
  const message=$('message').value.trim();if(!message){$('chat-status').textContent='Scrivi un messaggio.';return;}
  // Retain the same ID after an ambiguous network response: the server returns its original receipt.
  if(pendingSubmission&&(pendingSubmission.message!==message||pendingSubmission.kind!==kind)){
    $('chat-status').textContent='Prima reinvia il messaggio precedente per recuperarne la ricevuta.';return;
  }
  pendingSubmission??={requestId:requestId(),message,kind};busy=true;
  $('send-message').disabled=true;$('analyze-message').disabled=true;
  try{
    const accepted=await api(kind==='analysis'?'analyze':'chat',{message,requestId:pendingSubmission.requestId});
    $('chat-status').textContent='Richiesta accettata · '+accepted.job.id+' · '+jobState(accepted.job.state)+'. Puoi inviarne altre.';
    pendingSubmission=null;$('message').value='';await refresh();
  }catch(e){$('chat-status').textContent=e.message+' · Puoi reinviare lo stesso messaggio per recuperare la ricevuta.';}
  finally{busy=false;$('send-message').disabled=false;$('analyze-message').disabled=false;}
}
function jobState(state){return ({queued:'In coda',running:'In esecuzione',waiting:'In attesa',completed:'Completata',failed:'Non completata',cancelled:'Annullata'})[state]??state;}
function renderJobs(s){
  const pool=s.pool??{};$('pool-status').textContent='Coordinatore: '+(pool.coordinatorRunning?'occupato':'disponibile')+' · analisti: '+(pool.analystRunning??0)+' / '+(pool.maxAnalysts??2)+' · un solo esecutore finanziario';
  const q=s.queue??{},counts=(q.states??[]).map(x=>jobState(x.state)+': '+x.count).join(' · ');
  $('queue-status').textContent=counts+(q.averageWaitMs!=null?' · attesa media '+Math.round(q.averageWaitMs/1000)+' s':'')+' · limite coda '+(q.maxPending??100);
  $('jobs').replaceChildren();
  for(const job of s.jobs??[]){
    const row=document.createElement('article');row.className='decision';
    const title=document.createElement('strong');title.textContent=job.kind+' · '+jobState(job.state);row.append(title);
    const detail=document.createElement('p');detail.textContent=job.created_at+(job.scope?' · '+job.scope:'')+(job.wait_reason?' · '+job.wait_reason:'');row.append(detail);
    if(job.result){try{const result=JSON.parse(job.result);const answer=document.createElement('p');answer.textContent=result.answer??'';row.append(answer);}catch{}}
    if(job.error){const error=document.createElement('p');error.textContent=job.error;row.append(error);}
    if(job.state==='queued'||(job.state==='waiting'&&!job.submitted)){
      const cancel=document.createElement('button');cancel.textContent='Annulla richiesta';cancel.onclick=async()=>{try{await api('jobs/cancel',{id:job.id});await refresh();}catch(e){$('chat-status').textContent=e.message;}};row.append(cancel);
    }
    $('jobs').append(row);
  }
}
$('chat-form').onsubmit=e=>{e.preventDefault();void submitMessage('chat');};
$('analyze-message').onclick=()=>void submitMessage('analysis');void refresh();setInterval(refresh,5000);

$('owner-form').onsubmit=async e=>{e.preventDefault();try{const login=await api('owner/login',{password:$('owner-password').value});ownerSession=login.session;sessionStorage.setItem('satssurge.ownerSession',ownerSession);$('owner-password').value='';await refresh();}catch(e){$('connection').textContent=e.message;}};

function renderEvaluations(s){
  $('evaluations').replaceChildren();
  if(!(s.evaluationWindows??[]).length){$('evaluations').textContent='Nessuna finestra di valutazione ancora maturata.';return;}
  for(const report of s.evaluationWindows){
    const row=document.createElement('article');row.className='decision';const title=document.createElement('strong');title.textContent=report.horizon_days+' giorni · revisione '+report.revision+' · '+report.status;row.append(title);
    const r=report.result;const summary=document.createElement('p');summary.textContent='Contributo osservato: '+(r.observedContributionMsat==null?'non determinabile':sats(r.observedContributionMsat)+' sat')+' · costi: '+(r.costMsat==null?'non determinabili':sats(r.costMsat)+' sat')+' · '+r.samples+' inoltri · copertura '+(r.coverageComplete?'completa nella finestra':'incompleta');row.append(summary);
    const detail=document.createElement('details'),label=document.createElement('summary'),data=document.createElement('pre');label.textContent='Previsione originale, ipotesi e limiti';data.textContent=JSON.stringify(r,null,2);detail.append(label,data);row.append(detail);$('evaluations').append(row);
  }
}

function renderDiagnostics(s){
  $('diagnostics').replaceChildren();
  for(const name of ['lndg','lightningMate']){
    const d=s.diagnostics?.[name],row=document.createElement('article');row.className='decision';
    const title=document.createElement('strong');title.textContent=(name==='lndg'?'LNDg':'Lightning Mate')+' · '+(d?.version??'versione sconosciuta')+' · '+(d?.status??'non disponibile');row.append(title);
    const detail=document.createElement('p');detail.textContent=d?.status==='qualified'?'Acquisito: '+d.capturedAt+' · '+d.failures.length+' record di errore · '+d.rebalances.length+' rebalance nel log · copertura '+(d.coverage.complete?'completa':'parziale'):d?.reason??'Esportazione non ancora disponibile';row.append(detail);
    if(d?.status==='qualified'){
      const groups=new Map();for(const failure of d.failures){const key=(failure.source??'ingresso non registrato')+' → '+failure.target;const group=groups.get(key)??{count:0n,amount:0n};group.count+=BigInt(failure.count??1);group.amount+=BigInt(failure.amountMsat);groups.set(key,group);}
      for(const [key,value] of [...groups].sort((a,b)=>a[1].count>b[1].count?-1:a[1].count<b[1].count?1:0).slice(0,10)){
        const line=document.createElement('p');line.textContent=key+' · '+value.count+' tentativi/riepiloghi osservati · '+sats(value.amount)+' sat richiesti';row.append(line);
      }
      const note=document.createElement('p');note.className='muted';note.textContent=d.coverage.note;row.append(note);
    }
    $('diagnostics').append(row);
  }
}

function renderCompetition(s){
  $('competition').replaceChildren();const capture=s.competition;
  if(capture?.status!=='qualified'){$('competition').textContent=capture?.reason??'Confronto non ancora disponibile';return;}
  for(const channel of capture.channels){
    const row=document.createElement('article');row.className='decision';
    const title=document.createElement('strong');title.textContent=channel.alias+' · '+channel.status;row.append(title);
    if(channel.quotes){
      const coverage=document.createElement('p');coverage.textContent='Grafo: '+channel.capturedChannels+' / '+channel.graphChannelCount+' canali · policy mancanti: '+channel.missingPolicies+' · '+channel.capturedAt;row.append(coverage);
      for(const q of channel.quotes){
        const line=document.createElement('p');line.textContent=q.amountSat+' sat: nostra fee '+sats(q.ourFeeMsat)+' sat · mediana annunciata '+(q.medianFeeMsat===null?'sconosciuta':sats(q.medianFeeMsat)+' sat')+' · '+q.cheaperThanUs+' / '+q.announcedEligible+' prezzi inferiori al nostro';row.append(line);
      }
      const note=document.createElement('p');note.className='muted';note.textContent='Confronto di prezzi annunciati: non prova rotte eseguibili, domanda o redditività.';row.append(note);
    }else{const note=document.createElement('p');note.textContent=channel.reason;row.append(note);}
    $('competition').append(row);
  }
}
