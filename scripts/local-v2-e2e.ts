#!/usr/bin/env tsx
/** Synthetic mechanism test on disposable local EVM. No real keys or external RPC. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { caseIdFor, type CaseRecord } from '../src/evidence/case.js';
import { RULE_LABEL } from '../src/verifier/rules.js';
import { signCase } from '../src/verifier/sign.js';
const port = 18546;
// Fail before spawning if another process owns the port.
await new Promise<void>((ok, fail) => { const s = createServer(); s.once('error', fail); s.listen(port, '127.0.0.1', () => s.close(e => e ? fail(e) : ok())); });
const proc = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '5042002', '--silent'], { stdio: 'ignore' });
let startError: Error | undefined;
proc.once('error', e => { startError = e; });
const chain = { id: 5042002, name: 'Local synthetic Arc-domain EVM', nativeCurrency: { name: 'test', symbol: 'TEST', decimals: 18 }, rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } } } as const;
const client = createPublicClient({ chain, transport: http() });
try {
 let ready = false;
 for (let n = 0; n < 40; n++) { if (startError) throw startError; try { assert.equal(await client.getChainId(), 5042002); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); } }
 assert.ok(ready, 'local EVM must start');
 const owner = privateKeyToAccount(generatePrivateKey());
 const agent = privateKeyToAccount(generatePrivateKey());
 const verifierKey = generatePrivateKey();
 const verifier = privateKeyToAccount(verifierKey);
 const payee = privateKeyToAccount(generatePrivateKey()).address;
 for (const a of [owner, agent]) await client.request({ method: 'anvil_setBalance' as any, params: [a.address, '0x56bc75e2d63100000'] as any });
 const ow = createWalletClient({ chain, account: owner, transport: http() });
 const aw = createWalletClient({ chain, account: agent, transport: http() });
 const artifact = (name: string) => JSON.parse(readFileSync(name, 'utf8'));
 const tokenArtifact = artifact('contracts/out/AgoranomosSettlement.t.sol/MockUSDC.json');
 const settlementArtifact = artifact('contracts/out/AgoranomosSettlement.sol/AgoranomosSettlement.json');
 const receipt = async (hash: Hex) => { const r = await client.waitForTransactionReceipt({ hash }); assert.equal(r.status, 'success'); return r; };
 const token = (await receipt(await ow.deployContract({ abi: tokenArtifact.abi, bytecode: tokenArtifact.bytecode.object }))).contractAddress as Address;
 const ruleVersion = keccak256(toBytes(RULE_LABEL));
 const contract = (await receipt(await ow.deployContract({ abi: settlementArtifact.abi, bytecode: settlementArtifact.bytecode.object, args: [token, owner.address, agent.address, verifier.address, ruleVersion, 86400n, 1000000n, 250000n] }))).contractAddress as Address;
 const ownerCall = (functionName: string, args: unknown[]) => ow.writeContract({ address: contract, abi: settlementArtifact.abi, functionName, args }).then(receipt);
 await receipt(await ow.writeContract({ address: token, abi: tokenArtifact.abi, functionName: 'mint', args: [contract, 1000000n] }));
 await ownerCall('setPayee', [payee, true]);
 const make = (id: string): CaseRecord => ({ caseId: caseIdFor(['synthetic-v2-e2e', id]), kind: 'duplicate_charge_refund', counterparty: 'fixture', contract: [], inference: [], observed: [
 { kind: 'upstream_order', source: 'fixture', ref: 'o1', taskId: 't1', requestFingerprint: 'fp', submittedAtMs: 1000, chargedMicro: 500000 },
 { kind: 'upstream_order', source: 'fixture', ref: 'o2', taskId: 't2', requestFingerprint: 'fp', submittedAtMs: 2000, chargedMicro: 500000 },
 { kind: 'duplicate_intent_assessment', source: 'fixture', ref: 'review', intentId: 'i1', originalTaskId: 't1', repeatedTaskId: 't2', outcome: 'confirmed_duplicate' }] });
 const req = (record: CaseRecord) => ({ record, registry: { fixture: payee }, chainId: 5042002, contract, token, ruleVersion, ttlSeconds: 3600 });
 const signed = await signCase(req(make('paid')), verifierKey); assert.ok(signed.signed);
 const missing = make('missing'); missing.observed.pop(); assert.equal((await signCase(req(missing), verifierKey)).signed, false);
 const rejected = make('rejected'); (rejected.observed[2] as any).outcome = 'intentional_regeneration'; assert.equal((await signCase(req(rejected), verifierKey)).signed, false);
 const { attestation: a, signature } = signed.result;
 const refusal = async (expected: string, att: typeof a, sig: Hex, amount: bigint, seq = 0n) => { await assert.rejects(client.simulateContract({ account: agent.address, address: contract, abi: settlementArtifact.abi, functionName: 'settle', args: [att, sig, amount, seq, keccak256(toBytes('fixture'))] }), new RegExp(expected)); };
 await refusal('PayeeNotAllowed', { ...a, payee: owner.address }, signature, 200000n);
 await refusal('ExceedsAttestedMaximum', a, signature, 500001n);
 await receipt(await aw.writeContract({ address: contract, abi: settlementArtifact.abi, functionName: 'settle', args: [a, signature, 200000n, 0n, keccak256(toBytes('fixture'))] }));
 await refusal('IntentAlreadyUsed', a, signature, 100000n, 0n);
 const pending = await signCase(req(make('pending')), verifierKey); assert.ok(pending.signed);
 const p = pending.result;
 await receipt(await aw.writeContract({ address: contract, abi: settlementArtifact.abi, functionName: 'settle', args: [p.attestation, p.signature, 100000n, 0n, keccak256(toBytes('human review'))] }));
 await refusal('PendingAlreadyOpen', p.attestation, p.signature, 10000n, 1n);
 await ownerCall('approve', [p.attestation.caseId]);
 const rejectedPayment = await signCase(req(make('human-rejected')), verifierKey); assert.ok(rejectedPayment.signed);
 const d = rejectedPayment.result;
 await receipt(await aw.writeContract({ address: contract, abi: settlementArtifact.abi, functionName: 'settle', args: [d.attestation, d.signature, 100000n, 0n, keccak256(toBytes('rejected'))] }));
 await ownerCall('reject', [d.attestation.caseId]);
 assert.equal(await client.readContract({ address: token, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [payee] }), 300000n);
 assert.equal(await client.readContract({ address: contract, abi: settlementArtifact.abi, functionName: 'paid', args: [d.attestation.caseId] }), 0n);
 console.log(JSON.stringify({ network: 'local-only', synthetic: true, ruleLabel: RULE_LABEL, paidMicro: 300000, autonomousMicro: 200000, approvedMicro: 100000, humanRejectedMicro: 100000, rejectedControls: 6, controls: ['missing business intent', 'intentional regeneration', 'wrong payee', 'above attested ceiling', 'intent replay', 'pending overwrite'], publicDeployment: false }));
} finally { proc.kill('SIGTERM'); }
