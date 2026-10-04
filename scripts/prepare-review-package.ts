#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
const target=resolve(process.argv[2]??'../tameion/review-candidate-20261004');
if(existsSync(target))throw Error('Preserve existing candidate; choose a new directory');
mkdirSync(target,{recursive:true});
const repo=join(target,'source-history');mkdirSync(repo);
execFileSync('git',['init','-q','--initial-branch=main'],{cwd:repo});
const original=execFileSync('git',['fast-export','--all'],{maxBuffer:100*1024*1024});
// Only transform exporter metadata, never bytes inside a data block.
const chunks:Buffer[]=[];let pos=0,normalized=0;
while(pos<original.length){const end=original.indexOf(10,pos);if(end<0){chunks.push(original.subarray(pos));break;}const line=original.subarray(pos,end).toString();pos=end+1;const match=line.match(/^(author|committer|tagger) .* <[^>]+> (\d+ [+-]\d{4})$/);
 if(match){chunks.push(Buffer.from(`${match[1]} Sumplus contributors <contact@sumplus.org> ${match[2]}\n`));normalized++;}else chunks.push(Buffer.from(line+'\n'));
 const data=line.match(/^data (\d+)$/);if(data){const n=Number(data[1]);chunks.push(original.subarray(pos,pos+n));pos+=n;}
}
execFileSync('git',['fast-import','--quiet'],{cwd:repo,input:Buffer.concat(chunks),maxBuffer:10*1024*1024});
execFileSync('git',['checkout','-q','main'],{cwd:repo});
const originals=execFileSync('git',['rev-list','--reverse','main'],{encoding:'utf8'}).trim().split('\n');
const candidates=execFileSync('git',['rev-list','--reverse','main'],{cwd:repo,encoding:'utf8'}).trim().split('\n');
if(originals.length!==candidates.length)throw Error('History count changed');
const map=originals.map((sha,i)=>{const a=execFileSync('git',['show','-s','--format=%T %ct',sha],{encoding:'utf8'}).trim();const b=execFileSync('git',['show','-s','--format=%T %ct',candidates[i]],{cwd:repo,encoding:'utf8'}).trim();if(a!==b)throw Error('Source tree or original timestamp changed');return{original:sha,candidate:candidates[i],treeAndTime:a};});
const baseline=execFileSync('git',['rev-parse','tameion-start^{tree}'],{encoding:'utf8'}).trim();const candidateBaseline=execFileSync('git',['rev-parse','tameion-start^{tree}'],{cwd:repo,encoding:'utf8'}).trim();if(baseline!==candidateBaseline)throw Error('Baseline tree changed');
execFileSync('git',['bundle','create',join(target,'source-history.bundle'),'--all'],{cwd:repo});
execFileSync('git',['archive','--format=zip',`--output=${join(target,'source.zip')}`,'main'],{cwd:repo});
const diff=execFileSync('git',['diff','tameion-start...main'],{cwd:repo,maxBuffer:30*1024*1024});writeFileSync(join(target,'event-period.diff'),diff);
const site=join(target,'site');mkdirSync(site);for(const f of ['index.html','app.js','style.css'])cpSync(join('demo',f),join(site,f));
writeFileSync(join(site,'config.js'),"window.AGORA_REPORT_URL='./sample-report.json';\nwindow.AGORA_MECHANISM_URL='./mechanism-report.json';\n");
writeFileSync(join(site,'sample-report.json'),JSON.stringify({mode:'synthetic',report:null})+'\n');
const mechanism=JSON.parse(readFileSync('private-data/local-v2-report.json','utf8'));if(mechanism.synthetic!==true||mechanism.publicDeployment!==false||mechanism.network!=='local-only')throw Error('Unexpected mechanism report');
writeFileSync(join(site,'mechanism-report.json'),JSON.stringify(mechanism,null,2)+'\n');
writeFileSync(join(target,'deploy-static.txt'),'Deploy only the site directory to an approved static host. It requires no server, secrets, private dataset, wallet connection or write API. It works under a URL subdirectory. Source history contains normalized Sumplus contributor identities, while source trees, commit ordering, commit times and baseline are preserved. This candidate has not been published.\n');
const receipt={preparedAt:new Date().toISOString(),candidateHead:candidates.at(-1),baselineTree:baseline,commitCount:map.length,normalizedMetadataFields:normalized,eventDiffSha256:createHash('sha256').update(diff).digest('hex'),sourceZipSha256:createHash('sha256').update(readFileSync(join(target,'source.zip'))).digest('hex'),historyBundleSha256:createHash('sha256').update(readFileSync(join(target,'source-history.bundle'))).digest('hex'),privateHistoryMapping:map,published:false};
writeFileSync(join(target,'private-build-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({target,candidateHead:receipt.candidateHead,commitCount:receipt.commitCount,treeAndTimePreserved:true,baselinePreserved:true,published:false}));
