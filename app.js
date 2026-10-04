const $ = (selector) => document.querySelector(selector);
const el = (tag, text, className) => { const node = document.createElement(tag); node.textContent = text; if(className) node.className = className; return node; };
const synthetic = { datasetLabel: 'Synthetic example', disclosure: ['Illustrative fixtures only. No private report was found.', 'No verified supplier invoice is available. No settlement is authorized.'], cases: [1,2,3].map(i => ({id:`sample-${i}`,label:`Synthetic case ${i}`,requestedSeconds:10,measuredSeconds:i===2?8:10,sourceDate:'Illustrative',evidenceStatus:'Synthetic fixture'})), strategies:['fixed','fixed_probe','adaptive'].map((id,i)=>({id,label:['Fixed rules','Fixed probes','Adaptive rules'][i],attempts:3,passed:0,totalCost:0,decisions:[{caseId:'All synthetic cases',action:'no_action',reason:'Missing independent billing evidence. Escalate for human review.',verifierSign:false}]})) };
function render(data) {
 const isSynthetic=data.mode==='synthetic'; const r=data.report ?? synthetic;
 if(!Array.isArray(r.cases)||!Array.isArray(r.strategies)||!Array.isArray(r.disclosure)) throw new Error('Invalid report structure; regenerate replay.');
 $('#mode').className=`notice${isSynthetic?' synthetic':''}`;
 $('#mode').textContent=isSynthetic?'SYNTHETIC SAMPLE · Illustrative data only. Generate a private replay report to inspect historical evidence.':'PRE-EVENT DATA REPLAY · Historical records, not event-period traction. Private local review only.';
 $('#count').textContent=`${r.cases.length} cases · one shared evidence snapshot per case`;
 $('#cases').replaceChildren();
 r.cases.forEach(c=>{const card=el('article',null,'card');card.append(el('small',c.sourceDate),el('h3',c.label),el('div',`${c.measuredSeconds ?? 'Unmeasured'} s`,'metric'),el('p',`Requested: ${c.requestedSeconds ?? 'Unknown'} seconds · measured container duration (ffprobe)`),el('span',c.evidenceStatus,'tag'));$('#cases').append(card)});
 $('#disclosure').textContent=r.disclosure.join(' ');
 $('#strategies').replaceChildren();
 r.strategies.forEach(s=>{const card=el('article',null,'card'); card.append(el('small',s.id),el('h3',({fixed:'Fixed rules',fixed_probe:'Fixed probes',adaptive:'Adaptive rules'})[s.id]??s.label),el('div',`${s.passed} / ${s.attempts}`,'metric'),el('p','Cases passing the verifier. This is not an accuracy or success rate.'),el('span',`New external replay spend: $${s.totalCost/1e6} · CPU excluded`,'tag'));const scored=r.score?.cohorts?.flatMap(c=>c.policies??[]).find(p=>p.policy===s.id);if(scored)card.append(el('p',`Captured evidence reads: ${scored.evidence.probeCount} · new external probe spend: ${scored.evidence.probeCostMicro} micro-units. CPU excluded.`));s.decisions.forEach(d=>{card.append(el('p',`${r.cases.find(c=>c.id===d.caseId)?.label ?? d.caseId} · ${d.action} · ${d.verifierSign?'Signature permitted':'No signature'}\n${d.reason}`))});$('#strategies').append(card)});
 $('#raw').textContent=JSON.stringify(r,null,2);
}
async function refresh(){try{const res=await fetch(window.AGORA_REPORT_URL ?? './api/report');if(!res.ok)throw new Error('Local report unavailable or invalid.');render(await res.json())}catch(e){$('#mode').className='notice error';$('#mode').textContent=e.message;$('#cases').replaceChildren();$('#strategies').replaceChildren();$('#raw').textContent='';$('#disclosure').textContent='';$('#count').textContent='';}}
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('.panel').forEach(p=>p.hidden=p.id!==button.dataset.tab);document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b===button))}));$('#refresh').addEventListener('click',refresh);refresh();

async function loadMechanism(){
 try {
  const response=await fetch(window.AGORA_MECHANISM_URL ?? './api/mechanism');
  if(!response.ok)throw new Error('Mechanism report unavailable.');
  const r=await response.json();
  if(r.synthetic!==true||r.publicDeployment!==false||r.network!=='local-only')throw new Error('Expected an explicitly synthetic local mechanism report.');
  const fields=[['Autonomous payment',r.autonomousMicro],['Human-approved payment',r.approvedMicro],['Human-rejected proposal',r.humanRejectedMicro]];
  const out=$('#mechanism-results');out.replaceChildren();
  for(const [label,n] of fields){if(!Number.isSafeInteger(n)||n<0)throw new Error('Invalid local mechanism amounts.');const c=el('article',null,'card');c.append(el('small','LOCAL MOCK UNITS'),el('h3',label),el('div',(n/1e6).toFixed(2),'metric'),el('p','Synthetic mechanism fixture; no real business debt.'),el('span',r.ruleLabel,'tag'));out.append(c)}
  const controls=el('article',null,'card');controls.append(el('small','REJECTION CONTROLS'),el('h3',`${r.rejectedControls} refused paths`),el('p',(r.controls??[]).join(' · ')));out.append(controls);
 }catch(e){$('#mechanism-results').replaceChildren(el('p',e.message,'error'))}
}
loadMechanism();
