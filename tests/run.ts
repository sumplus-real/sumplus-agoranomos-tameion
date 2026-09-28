#!/usr/bin/env tsx
/**
 * Offline tests. The network is taken away for the whole run: a reviewer runs
 * these in an isolated environment, and a test that quietly reaches a live
 * service passes here and fails there.
 *
 * Test videos are generated here with ffmpeg. They check the measuring tool
 * itself and are not usage of any kind.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashTypedData, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ATTESTATION_TYPES, attestationDomain } from "../src/chain/settlement.js";
import { caseIdFor, evidenceHash, type CaseRecord, type UpstreamOrder } from "../src/evidence/case.js";
import { judge, RULE_LABEL, type PayeeRegistry } from "../src/verifier/rules.js";
import { signCase } from "../src/verifier/sign.js";
import { compare, measure } from "../src/video/measure.js";
import { append, readLog, verify } from "../src/loop/decision-log.js";
import { FixedPolicy, runDay, type Discrepancy, type Policy, type ProbeOption } from "../src/loop/day.js";
import { AdaptivePolicy } from "../src/loop/adaptive.js";

globalThis.fetch = (() => {
  throw new Error("these tests must not reach the network");
}) as typeof fetch;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const SUPPLIER: Address = "0x00000000000000000000000000000000000051e7";
const TENANT: Address = "0x0000000000000000000000000000000000007e7a";
const registry: PayeeRegistry = { "supplier:video-1": SUPPLIER, "tenant:studio-1": TENANT };

function order(taskId: string, fingerprint: string, atMs: number, charged: number) {
  return {
    kind: "upstream_order" as const,
    source: "studio-jobs",
    ref: `order:${taskId}`,
    taskId,
    requestFingerprint: fingerprint,
    submittedAtMs: atMs,
    chargedMicro: charged,
  };
}

function confirmation(repeatedTaskId: string, outcome: "confirmed_duplicate" | "intentional_regeneration" | "unknown" = "confirmed_duplicate") {
  return { kind: "duplicate_intent_assessment" as const, source: "synthetic-business-intent", ref: `confirmation:${repeatedTaskId}`,
    intentId: "synthetic-intent-1", originalTaskId: "t1", repeatedTaskId, outcome };
}

async function main() {
  console.log("0. Offline");
  let blocked = false;
  try {
    await fetch("https://example.invalid/");
  } catch (e) {
    blocked = String(e).includes("must not reach the network");
  }
  check("the network is unavailable to this run", blocked);

  console.log("1. Evidence hashing");
  const base: CaseRecord = {
    caseId: caseIdFor(["dup", "job-1"]),
    kind: "duplicate_charge_refund",
    counterparty: "supplier:video-1",
    observed: [order("t1", "fp-a", 1_000, 1_800_000), order("t2", "fp-a", 5_000, 1_800_000), confirmation("t2")],
    contract: [],
    inference: [],
  };
  const reordered: CaseRecord = { ...base, observed: [...base.observed].reverse() };
  check("the same facts in another order hash the same", evidenceHash(base, RULE_LABEL) === evidenceHash(reordered, RULE_LABEL));
  const edited: CaseRecord = { ...base, observed: [base.observed[0], { ...(base.observed[1] as UpstreamOrder), chargedMicro: 1_900_000 }] };
  check("changing one observed number changes the hash", evidenceHash(base, RULE_LABEL) !== evidenceHash(edited, RULE_LABEL));
  const withInference: CaseRecord = { ...base, inference: [{ claim: "x", lowMicro: 1, highMicro: 2, basis: "y" }] };
  check("the inference layer is not part of what gets attested", evidenceHash(base, RULE_LABEL) === evidenceHash(withInference, RULE_LABEL));

  console.log("2. Duplicate orders, observed");
  const dup = judge(base, registry);
  check("a confirmed duplicate business intent permits only the repeated charge", dup.sign === true && dup.maxMicro === 1_800_000, JSON.stringify(dup).slice(0, 90));
  check("the refund goes to the registered address, not one the case names", dup.sign === true && dup.payee === SUPPLIER);
  const unconfirmedFacts = base.observed.filter((f) => f.kind !== "duplicate_intent_assessment");
  check("identical hashes within ten minutes without intent confirmation are refused", !judge({ ...base, observed: unconfirmedFacts }, registry).sign);
  for (const outcome of ["intentional_regeneration", "unknown"] as const) {
    check(`${outcome} cannot authorize a duplicate refund`, !judge({ ...base, observed: [...unconfirmedFacts, confirmation("t2", outcome)] }, registry).sign);
  }
  check("conflicting intent confirmations are refused", !judge({ ...base, observed: [...base.observed, { ...confirmation("t2", "intentional_regeneration"), ref: "other-source-row" }] }, registry).sign);
  check("a confirmation for a missing order is refused", !judge({ ...base, observed: [...unconfirmedFacts, confirmation("unrelated-task")] }, registry).sign);
  check("blank business intent cannot authorize a refund", !judge({ ...base, observed: [...unconfirmedFacts, { ...confirmation("t2"), intentId: " " }] }, registry).sign);
  check("intent confirmation is committed in the evidence hash", evidenceHash(base, RULE_LABEL) !== evidenceHash({ ...base, observed: unconfirmedFacts }, RULE_LABEL));
  const single = judge({ ...base, observed: [base.observed[0]] }, registry);
  check("a single order is not a duplicate", single.sign === false);
  const sameTask = judge({ ...base, observed: [order("t1", "fp-a", 1_000, 1_800_000), order("t1", "fp-a", 2_000, 1_800_000)] }, registry);
  check("the same task id seen twice is one order, not two", sameTask.sign === false);
  const late = judge({ ...base, observed: [order("t1", "fp-a", 0, 1_800_000), order("t2", "fp-a", 11 * 60_000, 1_800_000)] }, registry);
  check("a repeat outside the window is treated as new work", late.sign === false);
  const three = judge({ ...base, observed: [order("t1", "fp-a", 0, 1_000_000), order("t2", "fp-a", 1_000, 1_000_000), order("t3", "fp-a", 2_000, 1_000_000), confirmation("t2"), confirmation("t3")] }, registry);
  check("every repeat after the first counts", three.sign === true && three.maxMicro === 2_000_000);
  const repeatedRow = judge({ ...base, observed: [...base.observed, base.observed[1]] }, registry);
  check("the same observed repeat row cannot raise the refund ceiling twice", repeatedRow.sign === true && repeatedRow.maxMicro === 1_800_000);
  const unsafeCharge = judge({ ...base, observed: [base.observed[0], order("t2", "fp-a", 5_000, Number.MAX_SAFE_INTEGER + 1)] }, registry);
  check("an unsafe integer charge is never signed", unsafeCharge.sign === false);
  const invalidTimestamp = judge({ ...base, observed: [base.observed[0], order("t2", "fp-a", Number.NaN, 1_800_000)] }, registry);
  check("a nonfinite order timestamp cannot bypass the duplicate window", invalidTimestamp.sign === false);
  const overflow = judge({ ...base, observed: [order("t1", "fp-a", 0, 1), order("t2", "fp-a", 1_000, Number.MAX_SAFE_INTEGER), order("t3", "fp-a", 2_000, 1), confirmation("t2"), confirmation("t3")] }, registry);
  check("an overflowing sum is never signed", overflow.sign === false);
  const unknown = judge({ ...base, counterparty: "supplier:nobody" }, registry);
  check("a counterparty with no registered address is refused", unknown.sign === false);

  console.log("3. Paying a supplier, measured against delivery");
  const pay: CaseRecord = {
    caseId: caseIdFor(["pay", "batch-1"]),
    kind: "pay_undisputed",
    counterparty: "supplier:video-1",
    observed: [
      { kind: "vendor_charge", source: "bill", ref: "c1", jobRef: "j1", billedSeconds: 5, chargedMicro: 500_000 },
      { kind: "vendor_charge", source: "bill", ref: "c2", jobRef: "j2", billedSeconds: 10, chargedMicro: 1_000_000 },
      { kind: "vendor_charge", source: "bill", ref: "c3", jobRef: "j3", billedSeconds: 5, chargedMicro: 500_000 },
      { kind: "delivery_measured", source: "ffprobe", ref: "d1", jobRef: "j1", measuredSeconds: 5.04 },
      { kind: "delivery_measured", source: "ffprobe", ref: "d2", jobRef: "j2", measuredSeconds: 5.0 },
      { kind: "delivery_unmeasurable", source: "ffprobe", ref: "d3", jobRef: "j3", reason: "the file is not there" },
    ],
    contract: [],
    inference: [],
  };
  const gatewayOnly: CaseRecord = { ...pay, observed: [
    { kind: "gateway_settlement", source: "gateway-ledger", ref: "g1", jobRef: "j1", requestedSeconds: 5, reportedSeconds: 5, settledMicro: 500_000, originTime: "2026-09-20T00:00:00Z" },
    { kind: "delivery_measured", source: "ffprobe", ref: "d1", jobRef: "j1", measuredSeconds: 5 },
  ] };
  check("gateway settlement and measured delivery do not impersonate a supplier invoice", !judge(gatewayOnly, registry).sign);
  const paid = judge(pay, registry);
  check("only the charge whose delivery matches is payable", paid.sign === true && paid.maxMicro === 500_000, paid.sign ? String(paid.maxMicro) : "");
  check("a short delivery is withheld and says by how much", paid.sign === true && paid.basis.some((b) => b.includes("withheld c2") && b.includes("5s")));
  check("an unmeasurable delivery is withheld, not counted as zero", paid.sign === true && paid.basis.some((b) => b.includes("withheld c3") && b.includes("could not be measured")));
  const duplicateVendor = judge({ ...pay, observed: [...pay.observed, pay.observed[0]] }, registry);
  check("a repeated vendor charge row cannot increase the payable ceiling", duplicateVendor.sign === true && duplicateVendor.maxMicro === 500_000);
  const conflictingVendor = judge({ ...pay, observed: [...pay.observed, { ...(pay.observed[0] as Extract<(typeof pay.observed)[number], { kind: "vendor_charge" }>), chargedMicro: 900_000 }] }, registry);
  check("conflicting vendor rows with one reference are refused", conflictingVendor.sign === false);
  const doubleJobCharge = judge({ ...pay, observed: [...pay.observed, { kind: "vendor_charge", source: "bill", ref: "c4", jobRef: "j1", billedSeconds: 5, chargedMicro: 500_000 }] }, registry);
  check("two charge references for one job cannot both be paid", doubleJobCharge.sign === false);
  const conflictingMeasurement = judge({ ...pay, observed: [...pay.observed, { kind: "delivery_measured", source: "ffprobe", ref: "d1-other", jobRef: "j1", measuredSeconds: 5.1 }] }, registry);
  check("conflicting delivery measurements for one job are refused", conflictingMeasurement.sign === false);
  const invalidMeasurement = judge({ ...pay, observed: pay.observed.map((f) => f.kind === "delivery_measured" && f.jobRef === "j1" ? { ...f, measuredSeconds: Number.NaN } : f) }, registry);
  check("a nonfinite delivery measurement cannot authorize payment", invalidMeasurement.sign === false);
  const badVendor = judge({ ...pay, observed: pay.observed.map((f) => f.kind === "vendor_charge" && f.ref === "c1" ? { ...f, chargedMicro: Number.NaN } : f) }, registry);
  check("a nonfinite vendor amount is never signed", badVendor.sign === false);

  console.log("4. Crediting a tenant");
  const credit = judge({
    caseId: caseIdFor(["credit", "j9"]),
    kind: "tenant_credit_undelivered",
    counterparty: "tenant:studio-1",
    observed: [
      { kind: "tenant_debit", source: "ledger", ref: "u1", jobRef: "j9", debitedMicro: 300_000 },
      { kind: "tenant_debit", source: "ledger", ref: "u2", jobRef: "j10", debitedMicro: 300_000 },
      { kind: "job_failed", source: "jobs", ref: "f1", jobRef: "j9" },
      { kind: "delivery_unmeasurable", source: "ffprobe", ref: "d10", jobRef: "j10", reason: "the file is not there" },
    ],
    contract: [],
    inference: [],
  }, registry);
  check("a debit for a failed job is creditable", credit.sign === true && credit.maxMicro === 300_000);
  check("an unmeasurable file is not treated as a failed job", credit.sign === true && credit.maxMicro === 300_000);
  const repeatDebitRecord: CaseRecord = { caseId: caseIdFor(["credit", "repeat"]), kind: "tenant_credit_undelivered", counterparty: "tenant:studio-1",
    observed: [{ kind: "tenant_debit", source: "ledger", ref: "u1", jobRef: "j9", debitedMicro: 300_000 },
      { kind: "job_failed", source: "jobs", ref: "f1", jobRef: "j9" }], contract: [], inference: [] };
  const repeatDebit = judge({ ...repeatDebitRecord, observed: [...repeatDebitRecord.observed, repeatDebitRecord.observed[0]] }, registry);
  check("a repeated tenant debit row cannot increase the credit ceiling", repeatDebit.sign === true && repeatDebit.maxMicro === 300_000);
  const conflictingDebit = judge({ ...repeatDebitRecord, observed: [...repeatDebitRecord.observed, { ...(repeatDebitRecord.observed[0] as Extract<(typeof repeatDebitRecord.observed)[number], { kind: "tenant_debit" }>), debitedMicro: 900_000 }] }, registry);
  check("conflicting tenant rows with one reference are refused", conflictingDebit.sign === false);
  const unsafeTenant = judge({
    caseId: caseIdFor(["credit", "unsafe"]), kind: "tenant_credit_undelivered", counterparty: "tenant:studio-1",
    observed: [{ kind: "tenant_debit", source: "ledger", ref: "unsafe", jobRef: "j1", debitedMicro: Number.MAX_SAFE_INTEGER + 1 },
      { kind: "job_failed", source: "jobs", ref: "failed", jobRef: "j1" }], contract: [], inference: [],
  }, registry);
  check("an unsafe tenant debit is never signed", unsafeTenant.sign === false);

  console.log("5. Signing");
  const verifierKey = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
  const verifierAddress = privateKeyToAccount(verifierKey).address;
  const contract: Address = "0xc8e1dc15F42c04EaF5Eab03C5A82C8Abc4aB01d2";
  const token: Address = "0x3600000000000000000000000000000000000000";
  const rules: Hex = "0x49b5c5936b16ec2a73f5dd855c266a1270422828f0681571d35ba195f745aa2b";
  const out = await signCase({ record: base, registry, chainId: 5042002, contract, token, ruleVersion: rules, ttlSeconds: 3600, nowSeconds: 1_700_000_000 }, verifierKey);
  check("a case the rules accept is signed", out.signed === true);
  if (out.signed) {
    const a = out.result.attestation;
    const recovered = await recoverTypedDataAddress({
      domain: attestationDomain(5042002, contract), types: ATTESTATION_TYPES, primaryType: "Attestation", message: a, signature: out.result.signature,
    });
    check("the signature recovers to the verifier", recovered === verifierAddress);
    check("the ceiling is the verifier's own, from the facts", a.maxAmount === 1_800_000n);
    check("the payee comes from the registry", a.payee === SUPPLIER);
    const otherChain = hashTypedData({ domain: attestationDomain(1, contract), types: ATTESTATION_TYPES, primaryType: "Attestation", message: a });
    const thisChain = hashTypedData({ domain: attestationDomain(5042002, contract), types: ATTESTATION_TYPES, primaryType: "Attestation", message: a });
    check("the same case hashes differently on another chain", otherChain !== thisChain);
  }
  const unconfirmedSignature = await signCase({ record: { ...base, observed: unconfirmedFacts }, registry, chainId: 5042002, contract, token, ruleVersion: rules, ttlSeconds: 3600 }, verifierKey);
  check("same-hash orders without business confirmation never produce a signature", !unconfirmedSignature.signed);
  const refused = await signCase({ record: { ...base, observed: [base.observed[0]] }, registry, chainId: 5042002, contract, token, ruleVersion: rules, ttlSeconds: 3600 }, verifierKey);
  check("a case the rules reject is not signed at all", refused.signed === false);

  console.log("6. The agent cannot reach the verifier's key");
  const agentDir = join(ROOT, "src", "agent");
  const agentFiles = readdirSync(agentDir).filter((f) => f.endsWith(".ts"));
  check("there is agent code to inspect", agentFiles.length > 0, `${agentFiles.length} files`);
  const leaks = agentFiles.filter((f) => {
    const src = readFileSync(join(agentDir, f), "utf8");
    return /VERIFIER_PRIVATE_KEY|\.verifier\.env|verifier\/sign/.test(src);
  });
  check("no agent file reads the verifier key or imports the signer", leaks.length === 0, leaks.join(", "));
  const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
  check("key files are kept out of the repository", [".agent.env", ".verifier.env", ".deployer.env"].every((f) => gitignore.includes(f)));

  console.log("7. Measuring a delivered clip");
  const dir = mkdtempSync(join(tmpdir(), "agoranomos-"));
  const clip = (name: string, seconds: number) => {
    const path = join(dir, name);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=320x180:rate=24:duration=${seconds}`, "-pix_fmt", "yuv420p", path]);
    return path;
  };
  const five = await measure(clip("five.mp4", 5));
  check("a five-second clip measures five seconds", five.status === "measured" && Math.abs(five.seconds - 5) < 0.05, JSON.stringify(five));
  const two = await measure(clip("two.mp4", 2));
  check("a two-second clip measures two seconds", two.status === "measured" && Math.abs(two.seconds - 2) < 0.05);
  const missing = await measure(join(dir, "never-arrived.mp4"));
  check("a missing file is unmeasurable, not zero", missing.status === "unmeasurable");
  const junk = join(dir, "junk.mp4");
  writeFileSync(junk, "this is not a video");
  const broken = await measure(junk);
  check("a corrupt file is unmeasurable, not zero", broken.status === "unmeasurable");
  check("the generated clips exist", statSync(join(dir, "five.mp4")).size > 0);

  check("billed five, delivered five: consistent", compare(5, five).outcome === "consistent");
  check("billed five, delivered two: short by three", (() => { const c = compare(5, two); return c.outcome === "short" && c.shortBySeconds === 3; })());
  check("billed five, file missing: unmeasurable", compare(5, missing).outcome === "unmeasurable");

  console.log("8. The decision record");
  const logDir = mkdtempSync(join(tmpdir(), "agoranomos-log-"));
  const logPath = join(logDir, "decisions.jsonl");
  for (let i = 0; i < 4; i++) {
    append(logPath, { day: "2026-09-27", caseId: null, kind: "measured", by: "code", summary: `entry ${i}`, detail: { i } });
  }
  const genuine = readLog(logPath);
  check("four entries were written", genuine.length === 4);
  check("an untouched record verifies", verify(genuine).ok);
  const tampered = genuine.map((e) => ({ ...e, detail: { ...e.detail } }));
  tampered[1].summary = "entry 1, quietly rewritten";
  const tamperedResult = verify(tampered);
  const flagged = new Set(tamperedResult.problems.map((p) => p.seq));
  check("editing one entry breaks its own hash", tamperedResult.problems.some((p) => p.seq === 1 && p.kind === "hash_mismatch"));
  check("and the link held by the entry after it", tamperedResult.problems.some((p) => p.seq === 2 && p.kind === "broken_link"));
  check("and nothing before it", !flagged.has(0));

  console.log("9. One day of the loop");
  const d: Discrepancy = {
    line: "video-1",
    caseId: "case-a",
    observed: [],
    interval: { claim: "payable", lowMicro: 400_000, highMicro: 600_000, basis: "one delivery unmeasurable" },
  };
  const settledDay: Discrepancy = { ...d, caseId: pay.caseId, observed: pay.observed, record: pay,
    interval: { ...d.interval, lowMicro: 500_000, highMicro: 500_000 } };
  const options: ProbeOption[] = [
    { id: "p1", line: "text-1", description: "shared 2k prefix, 4 suffixes", costMicro: 30_000, separates: ["H1", "H2"] },
    { id: "p2", line: "text-1", description: "shared 8k prefix, 4 suffixes", costMicro: 90_000, separates: ["H1", "H2", "H4"] },
  ];
  const dayLog = join(logDir, "day.jsonl");
  const fixed = runDay({ day: "2026-09-27", logPath: dayLog, policy: new FixedPolicy(), discrepancies: [d, settledDay], probeOptions: options, hypotheses: [], probeBudgetMicro: 100_000 });
  check("the baseline escalates the open case", fixed.escalations === 1);
  check("the baseline pays only the settled one", fixed.proposals.filter((p) => p.action === "pay").length === 1);
  check("the baseline never proposes payment without a matching evidence record", new FixedPolicy().propose({ ...settledDay, record: undefined }).action === "no_action");
  check("the baseline spends nothing on evidence", fixed.probesChosen.length === 0);
  check("the day's record verifies", verify(readLog(dayLog)).ok);
  check("every step names who made the call", readLog(dayLog).every((e) => ["code", "model", "verifier", "contract", "person"].includes(e.by)));

  const greedy: Policy = {
    name: "greedy",
    explain: (_d, h) => ({ summary: "x", hypotheses: h }),
    chooseProbes: (o) => ({ chosen: o, reason: "take everything" }),
    propose: (dd) => ({ caseId: dd.caseId, action: "hold", record: null, reason: "x" }),
  };
  let overspendRefused = false;
  try {
    runDay({ day: "2026-09-27", logPath: join(logDir, "greedy.jsonl"), policy: greedy, discrepancies: [], probeOptions: options, hypotheses: [], probeBudgetMicro: 100_000 });
  } catch (e) {
    overspendRefused = String(e).includes("against a budget of 100000");
  }
  check("a policy that picks probes past the budget is refused", overspendRefused);

  console.log("10. Adaptive recommendations remain bounded by evidence");
  const adaptive = new AdaptivePolicy();
  const competing = [
    { id: "H1", statement: "one charge", support: { low: 0.2, high: 0.7 }, evidence: ["order:t1"] },
    { id: "H2", statement: "repeat charge", support: { low: 0.3, high: 0.8 }, evidence: ["order:t2"] },
    { id: "H4", statement: "separate request", support: { low: 0.1, high: 0.6 }, evidence: [] },
  ];
  const selection = adaptive.chooseProbes(options, competing, 30_000);
  check("adaptive selection uses the affordable discriminating probe", selection.chosen.length === 1 && selection.chosen[0].id === "p1");
  check("adaptive selection cannot infer a result from a probe it has only chosen", adaptive.explain(d, competing).hypotheses === competing);
  const candidate: Discrepancy = {
    line: "video-1", caseId: base.caseId, observed: base.observed,
    interval: { claim: "duplicate", lowMicro: 1_800_000, highMicro: 1_800_000, basis: "two distinct observed orders" },
    record: base,
  };
  check("overlapping explanations stay unresolved", adaptive.propose(candidate, competing).action === "no_action");
  check("missing case record cannot produce a payment proposal", adaptive.propose({ ...candidate, record: undefined }, []).action === "no_action");
  check("mismatched facts cannot produce a payment proposal", adaptive.propose({ ...candidate, observed: [base.observed[0]] }, []).action === "no_action");
  const resolved = adaptive.propose(candidate, []);
  check("resolved observed facts yield only a verifier-bound candidate", resolved.action === "refund" && resolved.record === base && resolved.reason.includes("independent verifier"));
  const adaptiveLog = join(logDir, "adaptive.jsonl");
  runDay({ day: "2026-09-28", logPath: adaptiveLog, policy: adaptive, discrepancies: [candidate], probeOptions: options, hypotheses: [], probeBudgetMicro: 30_000 });
  check("deterministic adaptive choices are recorded as code, not model", readLog(adaptiveLog).every((e) => e.by === "code"));
  check("the adaptive decision record verifies", verify(readLog(adaptiveLog)).ok);
  const forged: Policy = { ...greedy, chooseProbes: () => ({ chosen: [{ ...options[0] }], reason: "forged" }) };
  let forgedRefused = false;
  try {
    runDay({ day: "2026-09-28", logPath: join(logDir, "forged.jsonl"), policy: forged, discrepancies: [], probeOptions: options, hypotheses: [], probeBudgetMicro: 100_000 });
  } catch (e) {
    forgedRefused = String(e).includes("unknown or duplicate probe");
  }
  check("the loop rejects a probe not drawn from its supplied options", forgedRefused);

  console.log("11. Probe execution and reassessment");
  const probe: ProbeOption = { id: "check-repeat", line: "video-1", description: "inspect a third order", costMicro: 10, separates: ["H1", "H2"] };
  const openCase: Discrepancy = { ...candidate, interval: { ...candidate.interval, lowMicro: 1_800_000, highMicro: 2_000_000 } };
  const pendingLog = join(logDir, "pending.jsonl");
  const pending = runDay({ day: "2026-09-28", logPath: pendingLog, policy: adaptive, discrepancies: [openCase], probeOptions: [probe], hypotheses: competing.slice(0, 2), probeBudgetMicro: 10 });
  check("without an executor the selected probe costs nothing and the case stays pending", pending.probesChosen.length === 1 && pending.probesExecuted === 0 && pending.probeSpentMicro === 0 && pending.proposals[0].action === "no_action");

  const third = order("t3", "fp-a", 6_000, 200_000);
  const afterProbe: CaseRecord = { ...base, observed: [...base.observed, third, confirmation("t3")] };
  const revisedLog = join(logDir, "revised.jsonl");
  const revisedDay = runDay({
    day: "2026-09-28", logPath: revisedLog, policy: adaptive, discrepancies: [openCase], probeOptions: [probe], hypotheses: competing.slice(0, 2), probeBudgetMicro: 10,
    executeProbe: () => ({ status: "observed", caseId: base.caseId, addedFacts: [third, confirmation("t3")], record: afterProbe,
      interval: { claim: "duplicate", lowMicro: 2_000_000, highMicro: 2_000_000, basis: "third observed order" },
      hypotheses: [{ ...competing[1], support: { low: 0.9, high: 1 } }], actualCostMicro: 8, reason: "third order found" }),
  });
  const revisedEntries = readLog(revisedLog);
  const kinds = revisedEntries.map((e) => e.kind);
  check("the loop chooses, observes, revises, then proposes in that order", kinds.indexOf("probe_chosen") < kinds.indexOf("probe_result") && kinds.indexOf("probe_result") < kinds.indexOf("revised") && kinds.indexOf("revised") < kinds.indexOf("proposed"));
  check("reassessment uses new observed facts and records actual cost", revisedDay.proposals[0].record === afterProbe && revisedDay.probeSpentMicro === 8 && revisedDay.probesExecuted === 1);
  const revisedVerdict = judge(afterProbe, registry);
  check("the independent verifier computes the revised ceiling", revisedVerdict.sign === true && revisedVerdict.maxMicro === 2_000_000);
  check("the revised decision log verifies", verify(revisedEntries).ok);

  const failedDay = runDay({
    day: "2026-09-28", logPath: join(logDir, "failed-probe.jsonl"), policy: adaptive, discrepancies: [openCase], probeOptions: [probe], hypotheses: competing.slice(0, 2), probeBudgetMicro: 10,
    executeProbe: () => ({ status: "failed", caseId: base.caseId, actualCostMicro: 3, reason: "source unavailable" }),
  });
  check("a failed probe records its cost and escalates", failedDay.proposals[0].action === "no_action" && failedDay.probeSpentMicro === 3);
  const overcostDay = runDay({
    day: "2026-09-28", logPath: join(logDir, "overcost.jsonl"), policy: adaptive, discrepancies: [openCase], probeOptions: [probe], hypotheses: competing.slice(0, 2), probeBudgetMicro: 10,
    executeProbe: () => ({ status: "failed", caseId: base.caseId, actualCostMicro: 11, reason: "charged above quote" }),
  });
  check("an over-quote executor result cannot update facts or produce a candidate", overcostDay.proposals[0].action === "no_action" && overcostDay.probesExecuted === 0 && overcostDay.probeSpentMicro === null);
  let executorCalls = 0;
  const twoProbes = [probe, { ...probe, id: "check-again" }];
  const halted = runDay({
    day: "2026-09-28", logPath: join(logDir, "halted.jsonl"), policy: greedy, discrepancies: [openCase], probeOptions: twoProbes, hypotheses: competing.slice(0, 2), probeBudgetMicro: 20,
    executeProbe: () => { executorCalls += 1; return { status: "failed", caseId: base.caseId, actualCostMicro: 11, reason: "over quote" }; },
  });
  check("uncertain cost stops later probe calls", executorCalls === 1 && halted.probeSpentMicro === null && halted.proposals[0].action === "no_action");

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
