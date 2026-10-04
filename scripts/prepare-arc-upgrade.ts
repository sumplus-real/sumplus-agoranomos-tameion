#!/usr/bin/env tsx
/** Read-only chain inspection and unsigned local deployment preparation. Never loads role keys. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, encodeDeployData, http, keccak256, toBytes, type Address } from 'viem';
import { ARC_TESTNET, ARC_USDC, SETTLEMENT_ADDRESS } from '../src/chain/settlement.js';
import { RULE_LABEL } from '../src/verifier/rules.js';
const artifact = JSON.parse(readFileSync('contracts/out/AgoranomosSettlement.sol/AgoranomosSettlement.json', 'utf8'));
const client = createPublicClient({ chain: ARC_TESTNET, transport: http(undefined, { timeout: 10000, retryCount: 0 }) });
const chainId = await client.getChainId();
if (chainId !== ARC_TESTNET.id) throw new Error('wrong Arc chain; no plan produced');
const code = await client.getCode({ address: SETTLEMENT_ADDRESS });
if (!code || code === '0x') throw new Error('historical settlement has no code');
const get = (functionName: string) => client.readContract({ address: SETTLEMENT_ADDRESS, abi: artifact.abi, functionName });
const [owner, agent, verifier, token, oldRules, periodLength, periodBudget, escalationThreshold] = await Promise.all(['owner', 'agent', 'verifier', 'token', 'ruleVersion', 'periodLength', 'periodBudget', 'escalationThreshold'].map(get));
if ((token as string).toLowerCase() !== ARC_USDC.toLowerCase()) throw new Error('unexpected settlement token');
const newRules = keccak256(toBytes(RULE_LABEL));
const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [token, owner, agent, verifier, newRules, periodLength, periodBudget, escalationThreshold] });
const plan = { preparedAt: new Date().toISOString(), chainId, oldContract: SETTLEMENT_ADDRESS, oldCodeHash: keccak256(code), oldRuleVersion: oldRules, newRuleVersion: newRules, roles: { owner, agent, verifier }, constructor: { token, periodLength, periodBudget, escalationThreshold }, bytecodeHash: keccak256(artifact.bytecode.object), unsignedDeployment: { from: owner as Address, data, value: '0' }, broadcast: false, safeguardsDeployed: false, requiredBeforeBroadcast: ['Owner reviews existing pending cases and balances; do not abandon a reservation or duplicate an intent.', 'Provision isolated verifier and authenticated reviewer registry; preserve current trusted identities until rotation is authorized.', 'Review target roles, budgets, gas funding, deployment estimate and capped testnet transaction budget.', 'Deploy new contract; old non-upgradeable contract cannot acquire the patched safeguards through a rule update.', 'Individually review allowlist and funding; do not copy/transfer funds automatically.', 'Re-read code, roles, rules and receipts; validate synthetic Arc mechanism controls separately from real business usage.', 'Switch agent endpoint only after acceptance; retain old audit logs and independent checkpoints.'], rollback: 'Before broadcasting, discard this file. After new deployment, keep agent on old endpoint until owner acceptance; no automatic migration or reverse transfer is performed.' };
mkdirSync('private-data/upgrade', { recursive: true });
writeFileSync(`private-data/upgrade/plan-${Date.now()}.json`, JSON.stringify(plan, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ chainId, oldContract: SETTLEMENT_ADDRESS, oldRuleVersion: oldRules, newRuleVersion: newRules, currentRuleMatchesV2: oldRules === newRules, unsignedOnly: true }));
