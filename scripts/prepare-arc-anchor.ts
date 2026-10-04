#!/usr/bin/env tsx
/** Prepare a public commitment only; private decision entries never leave disk. */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createPublicClient, http, parseAbi, type Address, type Hex } from 'viem';
import { canonicalJson } from '../src/evidence/case.js';
import { verifyCheckpoint, type LogCheckpoint } from '../src/loop/checkpoint.js';
import { ARC_TESTNET, SETTLEMENT_ADDRESS } from '../src/chain/settlement.js';
const root=process.argv[2];if(!root)throw Error('usage: prepare-arc-anchor private-data/replay/run-directory');
const files=readdirSync(root).filter(f=>f.endsWith('.checkpoint-20261004.json')).sort();if(files.length!==3)throw Error('Expected three policy checkpoints');
const checkpoints=files.map(f=>{const c=JSON.parse(readFileSync(join(root,f),'utf8')) as LogCheckpoint;const log=join(root,f.replace('.checkpoint-20261004.json','.jsonl'));if(!verifyCheckpoint(log,c))throw Error('Checkpoint does not bind the retained log');return c;});
const commitment=createHash('sha256').update(canonicalJson({version:1,checkpoints})).digest('hex');
const p=createPublicClient({chain:ARC_TESTNET,transport:http(undefined,{timeout:10000,retryCount:0})});if(await p.getChainId()!==5042002)throw Error('Wrong chain');
const owner=await p.readContract({address:SETTLEMENT_ADDRESS,abi:parseAbi(['function owner() view returns(address)']),functionName:'owner'}) as Address;
const data=('0x'+commitment) as Hex;const gas=await p.estimateGas({account:owner,to:owner,data,value:0n});const gasPrice=(await p.getGasPrice())*2n;const paddedGas=gas*12n/10n;const maximumFee=paddedGas*gasPrice;const cap=10000000000000000n;
const plan={preparedAt:new Date().toISOString(),chainId:5042002,network:'Arc testnet',unsignedOnly:true,commitmentAlgorithm:'SHA-256 of canonical JSON {version:1,checkpoints}',commitment,checkpointCount:3,checkpoints,transaction:{from:owner,to:owner,data,value:'0',gas:paddedGas.toString(),gasPrice:gasPrice.toString()},maxFeeWei:maximumFee.toString(),proposedFeeCapWei:cap.toString(),withinProposedCap:maximumFee<=cap,privateEntriesPublished:false,externalAnchorCreated:false,acceptance:['Re-estimate and obtain owner approval before signing; submit a zero-value self transaction with exactly this 32-byte commitment.','Retain the transaction hash and independently verify chain ID, sender, target, zero value, data, successful receipt and block inclusion.','Store the checkpoint set and receipt under a separate authorized custodian; verifyCheckpoint detects later rewrite against this original set.','A timestamped hash proves commitment existence at inclusion, not business truth, source authenticity or adoption.'],rollback:'Before broadcast discard this proposal. After broadcast the hash is public and cannot be removed; it contains no raw decision entries.'};
mkdirSync('private-data/anchor',{recursive:true});const file=`private-data/anchor/proposal-${Date.now()}.json`;writeFileSync(file,JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({file,checkpointCount:3,maxFeeTestUSDC:Number(maximumFee)/1e18,proposedFeeCapTestUSDC:0.01,unsignedOnly:true,rawEntriesPublished:false}));
