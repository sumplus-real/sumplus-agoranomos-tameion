#!/usr/bin/env tsx
/** Read-only proposal. No role key or wallet client, no broadcast. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, encodeDeployData, encodeFunctionData, http, keccak256, toBytes, parseAbi, type Address } from 'viem';
import { ARC_TESTNET, ARC_USDC, SETTLEMENT_ADDRESS } from '../src/chain/settlement.js';
import { RULE_LABEL } from '../src/verifier/rules.js';
const artifact=JSON.parse(readFileSync('contracts/out/AgoranomosSettlement.sol/AgoranomosSettlement.json','utf8'));
const p=createPublicClient({chain:ARC_TESTNET,transport:http(undefined,{timeout:10000,retryCount:0})});
if(await p.getChainId()!==5042002)throw Error('Wrong chain');
const get=(name:string)=>p.readContract({address:SETTLEMENT_ADDRESS,abi:artifact.abi,functionName:name});
const [owner,agent,verifier,oldRule,oldBudget,oldThreshold]=await Promise.all(['owner','agent','verifier','ruleVersion','periodBudget','escalationThreshold'].map(get));
const erc20=parseAbi(['function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)']);
const [ownerGas,agentGas,ownerToken,fee]=await Promise.all([p.getBalance({address:owner as Address}),p.getBalance({address:agent as Address}),p.readContract({address:ARC_USDC,abi:erc20,functionName:'balanceOf',args:[owner as Address]}),p.getGasPrice()]);
const newRule=keccak256(toBytes(RULE_LABEL));
const data=encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode.object,args:[ARC_USDC,owner,agent,verifier,newRule,86400n,1000000n,250000n]});
const gas=await p.estimateGas({account:owner as Address,data});
const paddedGas=gas*12n/10n,gasPrice=fee*2n;
const deployReserve=paddedGas*gasPrice;
const setupReserve=500000n*gasPrice;
const topup=agentGas>=100000000000000000n?0n:100000000000000000n-agentGas;
const proposedGasCap=2000000000000000000n;
const proposedFunding=1000000n;
const totalGasReserve=deployReserve+setupReserve+topup;
const totalOwnerNativeNeeded=totalGasReserve+proposedFunding*1000000000000n;
const plan={preparedAt:new Date().toISOString(),chainId:5042002,network:'Arc testnet',unsignedOnly:true,oldContract:SETTLEMENT_ADDRESS,oldRule,oldBudget,oldThreshold,newRule,proposed:{periodSeconds:'86400',periodBudgetMicro:'1000000',humanApprovalThresholdMicro:'250000',newContractFundingMicro:proposedFunding,ownerGasSpendCapWei:proposedGasCap,agentGasTopupWei:topup},roles:{owner,agent,verifier},observedBalances:{ownerNativeWei:ownerGas,ownerErc20Micro:ownerToken,agentNativeWei:agentGas},estimate:{deploymentGas:gas,paddedDeploymentGas:paddedGas,cappedGasPrice:gasPrice,deploymentReserveWei:deployReserve,setupAllowanceWei:setupReserve,totalGasReserveWei:totalGasReserve,totalOwnerNativeNeededWei:totalOwnerNativeNeeded,ownerAdditionalNativeRequiredWei:ownerGas>=totalOwnerNativeNeeded?0n:totalOwnerNativeNeeded-ownerGas,reserveWithinProposedCap:totalGasReserve<=proposedGasCap},unsignedDeployment:{from:owner,data,value:'0',gas:paddedGas,gasPrice},postDeploymentUnsignedSteps:[{name:'allowlist owner fixture payee',to:'NEW_CONTRACT_ADDRESS',data:encodeFunctionData({abi:artifact.abi,functionName:'setPayee',args:[owner,true]})},{name:'fund new contract with 1 test USDC',to:ARC_USDC,functionName:'transfer',args:['NEW_CONTRACT_ADDRESS','1000000']},{name:'agent gas if required',to:agent,valueWei:topup}],acceptance:['Confirm old pending cases, reservations, balances, source and artifact hashes before any broadcast.','Re-estimate at action time and cap cumulative actual gas plus topup at 2 test USDC; fund contract at most 1 test USDC.','Record inflight hashes before retry; successful receipt and readback required per step.','Verify new code, distinct roles, exact token/rules/budgets, then mechanism test capped separately.','Keep old endpoint read-only; no new business through baseline.','No transfer from old contract or private business decision without separately reviewed authorization.'],rollback:'Before broadcast delete candidate. After deployment disable the new agent; unused funding remains visible in new contract. This contract has no owner withdrawal function, so funding is not automatically recoverable; do not fund beyond the approved 1 test USDC.'};
mkdirSync('private-data/upgrade',{recursive:true});const file=`private-data/upgrade/budget-${Date.now()}.json`;writeFileSync(file,JSON.stringify(plan,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({file,estimateGas:String(gas),totalGasReserveTestUSDC:Number(totalGasReserve)/1e18,contractFundingTestUSDC:1,proposedGasCapTestUSDC:2,ownerAdditionalNativeTestUSDC:Number(plan.estimate.ownerAdditionalNativeRequiredWei)/1e18,unsignedOnly:true}));
