#!/usr/bin/env tsx
/**
 * End to end on Arc testnet, against the deployed contract.
 *
 * This is a mechanism test. The case below is written by hand to exercise the
 * path; it is not usage and is never counted as any. What it proves is that
 * the boundary holds on the real chain: the verifier's off-chain signature is
 * the one the contract checks, one honest settlement goes through, and the
 * four attacks the review named are each refused by the contract itself.
 *
 * Roles run in one script here for convenience, each loading only its own
 * key file. In operation they are separate processes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  hashTypedData,
  keccak256,
  toBytes,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ARC_TESTNET,
  ARC_USDC,
  ATTESTATION_TYPES,
  ERC20_ABI,
  SETTLEMENT_ABI,
  SETTLEMENT_ADDRESS,
  attestationDomain,
  type Attestation,
} from "../src/chain/settlement.js";
import { caseIdFor, type CaseRecord } from "../src/evidence/case.js";
import { RULE_LABEL } from "../src/verifier/rules.js";
import { signCase } from "../src/verifier/sign.js";
import { simulate, submit } from "../src/agent/submit.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
if (process.env.BROADCAST_TESTNET !== "1") throw new Error("live mechanism test is disabled; use local-v2-e2e for reversible preparation. Arc broadcasts require explicit authorization and BROADCAST_TESTNET=1");

function envValue(file: string, key: string): string {
  const line = readFileSync(join(ROOT, file), "utf8").split("\n").find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${file} has no ${key}`);
  return line.slice(key.length + 1).trim();
}

const publicClient = createPublicClient({ chain: ARC_TESTNET, transport: http() });
const owner = privateKeyToAccount(envValue(".deployer.env", "DEPLOYER_PRIVATE_KEY") as Hex);
const ownerWallet = createWalletClient({ chain: ARC_TESTNET, transport: http(), account: owner });
const agentAddress = envValue(".agent.env", "AGENT_ADDRESS") as Address;
const PAYEE = (process.env.TEST_PAYEE ?? "0x6D737E994d20376a0223A837C34622043Ec6C93c") as Address;
const SECOND_PAYEE = owner.address;

const usdc = (a: Address) => publicClient.readContract({ address: ARC_USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [a] });
const fmt = (micro: bigint) => `${Number(micro) / 1e6} USDC`;

async function ownerTx(label: string, request: Parameters<typeof ownerWallet.writeContract>[0]) {
  const hash = await ownerWallet.writeContract(request);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  ${label}: ${r.status} ${hash}`);
  if (r.status !== "success") throw new Error(`${label} failed`);
}

async function main() {
  console.log(`contract ${SETTLEMENT_ADDRESS}`);
  const ruleVersion = (await publicClient.readContract({ address: SETTLEMENT_ADDRESS, abi: SETTLEMENT_ABI, functionName: "ruleVersion" })) as Hex;
  if (ruleVersion !== keccak256(toBytes(RULE_LABEL))) throw new Error("deployed contract uses another rule version; prepare an owner-reviewed update before any setup or payment");
  const onchainVerifier = await publicClient.readContract({ address: SETTLEMENT_ADDRESS, abi: SETTLEMENT_ABI, functionName: "verifier" });
  console.log(`verifier on chain ${onchainVerifier}`);

  console.log("\n1. Setup (owner)");
  if ((await usdc(SETTLEMENT_ADDRESS)) < 500_000n) {
    await ownerTx("fund contract with 1 USDC", { address: ARC_USDC, abi: ERC20_ABI, functionName: "transfer", args: [SETTLEMENT_ADDRESS, 1_000_000n] });
  }
  // Two allowlisted payees, so that pointing a real signature at the second
  // one can only be stopped by the signature, not by the allowlist.
  for (const [label, who] of [["the test payee", PAYEE], ["a second allowlisted payee", SECOND_PAYEE]] as const) {
    if (!(await publicClient.readContract({ address: SETTLEMENT_ADDRESS, abi: SETTLEMENT_ABI, functionName: "allowedPayee", args: [who] }))) {
      await ownerTx(`allowlist ${label}`, { address: SETTLEMENT_ADDRESS, abi: SETTLEMENT_ABI, functionName: "setPayee", args: [who, true] });
    }
  }
  if ((await publicClient.getBalance({ address: agentAddress })) < parseEther("0.1")) {
    const hash = await ownerWallet.sendTransaction({ to: agentAddress, value: parseEther("0.3") });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  give the agent gas: ${hash}`);
  }
  console.log(`  contract holds ${fmt(await usdc(SETTLEMENT_ADDRESS))}, payee holds ${fmt(await usdc(PAYEE))}`);

  console.log("\n2. The verifier signs a case, in its own process");
  const run = Date.now().toString(36);
  const record: CaseRecord = {
    caseId: caseIdFor(["mechanism-test", run]),
    kind: "duplicate_charge_refund",
    counterparty: "test:payee",
    observed: [
      { kind: "upstream_order", source: "mechanism-test", ref: "o1", taskId: `t1-${run}`, requestFingerprint: `fp-${run}`, submittedAtMs: 1_000, chargedMicro: 500_000 },
      { kind: "upstream_order", source: "mechanism-test", ref: "o2", taskId: `t2-${run}`, requestFingerprint: `fp-${run}`, submittedAtMs: 4_000, chargedMicro: 500_000 },
      { kind: "duplicate_intent_assessment", source: "mechanism-test", ref: "synthetic-intent", intentId: `intent-${run}`, originalTaskId: `t1-${run}`, repeatedTaskId: `t2-${run}`, outcome: "confirmed_duplicate" },
    ],
    contract: [],
    inference: [],
  };
  const outcome = await signCase({
    record,
    registry: { "test:payee": PAYEE },
    chainId: ARC_TESTNET.id,
    contract: SETTLEMENT_ADDRESS,
    token: ARC_USDC,
    ruleVersion,
    ttlSeconds: 3600,
  });
  if (!outcome.signed) throw new Error(`verifier refused: ${outcome.reasons.join("; ")}`);
  const { attestation, signature, signer } = outcome.result;
  console.log(`  signed by ${signer}, ceiling ${fmt(attestation.maxAmount)}`);

  const local = hashTypedData({ domain: attestationDomain(ARC_TESTNET.id, SETTLEMENT_ADDRESS), types: ATTESTATION_TYPES, primaryType: "Attestation", message: attestation });
  const chain = (await publicClient.readContract({ address: SETTLEMENT_ADDRESS, abi: SETTLEMENT_ABI, functionName: "attestationDigest", args: [attestation] })) as Hex;
  console.log(`  digest off chain ${local}\n  digest on chain  ${chain}\n  ${local === chain ? "match" : "MISMATCH"}`);
  if (local !== chain) throw new Error("the off-chain and on-chain digests disagree");

  const results: { name: string; expected: string; got: string }[] = [];
  const expectRefusal = async (name: string, expected: string, a: Attestation, sig: Hex, amount: bigint, intentSeq = 0n) => {
    const r = await simulate({ attestation: a, signature: sig, amountMicro: amount, intentSeq, reasoning: name }, agentAddress);
    const got = r && r.status === "refused_by_contract" ? r.error : "not refused";
    results.push({ name, expected, got });
    console.log(`  ${got === expected ? "ok" : "WRONG"}: ${name} → ${got}`);
  };

  console.log("\n3. Attacks, before any payment");
  const agentSelfSigned = await privateKeyToAccount(envValue(".agent.env", "AGENT_PRIVATE_KEY") as Hex).signTypedData({
    domain: attestationDomain(ARC_TESTNET.id, SETTLEMENT_ADDRESS), types: ATTESTATION_TYPES, primaryType: "Attestation", message: attestation,
  });
  await expectRefusal("forged record: the agent signs its own attestation", "ForgedAttestation", attestation, agentSelfSigned, 500_000n);
  await expectRefusal("swapped payee: a real signature pointed at another allowlisted address", "ForgedAttestation", { ...attestation, payee: SECOND_PAYEE }, signature, 500_000n);
  await expectRefusal("inflated amount: more than the verifier's ceiling", "ExceedsAttestedMaximum", attestation, signature, 600_000n);

  console.log("\n4. A partial payment, submitted by the agent as intent 0");
  const before = await usdc(PAYEE);
  const sent = await submit({ attestation, signature, amountMicro: 200_000n, intentSeq: 0n, reasoning: "mechanism test: first part of the refund" });
  if (sent.status !== "settled_or_escalated") throw new Error(`the honest settlement was refused: ${sent.error}`);
  const after = await usdc(PAYEE);
  console.log(`  tx ${sent.txHash} in block ${sent.blockNumber}`);
  console.log(`  payee ${fmt(before)} → ${fmt(after)} (${fmt(after - before)})`);
  const paid = await publicClient.readContract({ address: SETTLEMENT_ADDRESS, abi: SETTLEMENT_ABI, functionName: "paid", args: [attestation.caseId] });
  console.log(`  contract records ${fmt(paid as bigint)} paid against this case`);

  console.log("\n5. Attacks, after the payment");
  // The one the ceiling cannot catch: 0.2 paid against a ceiling of 0.5,
  // and the same intent retried for 0.2 would still be under it.
  await expectRefusal("partial retry: intent 0 again, still under the ceiling", "IntentAlreadyUsed", attestation, signature, 200_000n, 0n);
  // Control: the same 0.2 under a fresh intent number goes through the
  // simulation, so the refusal above comes from the intent rule, not the ceiling.
  await expectRefusal("control: the same 0.2 as a new intent is allowed", "not refused", attestation, signature, 200_000n, 1n);
  await expectRefusal("new intent asking past the ceiling", "ExceedsAttestedMaximum", attestation, signature, 400_000n, 1n);
  const next = await publicClient.readContract({ address: SETTLEMENT_ADDRESS, abi: SETTLEMENT_ABI, functionName: "nextIntent", args: [attestation.caseId] });
  console.log(`  next intent number for this case: ${next}`);
  if (next !== 1n || paid !== 200_000n) throw new Error(`unexpected state: nextIntent ${next}, paid ${paid}`);

  const wrong = results.filter((r) => r.got !== r.expected);
  console.log(`\n${results.length - wrong.length}/${results.length} checks gave the expected answer; payee received ${fmt(after - before)}.`);
  if (wrong.length || after - before !== 200_000n) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
