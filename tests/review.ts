import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { signBusinessCase } from "../src/verifier/business.js";
import { RULE_LABEL } from "../src/verifier/rules.js";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { caseIdFor } from "../src/evidence/case.js";
import { importEvidence, type EvidenceBundle } from "../src/evidence/import.js";
import { reviewBundleHash, reviewPayload, type BusinessReview } from "../src/evidence/review.js";
import { append, readLog, verify } from "../src/loop/decision-log.js";
import { prepareCheckpoint, verifyCheckpoint } from "../src/loop/checkpoint.js";

const dir = mkdtempSync(join(tmpdir(), "agoranomos-review-"));
try {
  writeFileSync(join(dir, "source.txt"), "synthetic test source");
  const bundle: EvidenceBundle = { status: "business_unconfirmed", authorizationRef: "fixture-only", artifacts: [{ id: "source", path: "source.txt", sha256: createHash("sha256").update("synthetic test source").digest("hex"), capturedAt: "2026-10-04T00:00:00Z", provenance: "synthetic test" }], record: { caseId: caseIdFor(["review-fixture"]), kind: "tenant_credit_undelivered", counterparty: "fixture-business", observed: [{ kind: "tenant_debit", source: "source", ref: "r1", jobRef: "j1", debitedMicro: 100 }, { kind: "job_failed", source: "source", ref: "failed", jobRef: "j1" }], contract: [], inference: [] } };
  const keys = generateKeyPairSync("ed25519");
  const trust = { reviewer: { publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(), counterparty: "fixture-business" } };
  const r: BusinessReview = { version: 1, bundleHash: reviewBundleHash(bundle), reviewerId: "reviewer", outcome: "confirmed", reviewedAt: "2026-10-04T00:00:00Z", sourceRef: "fixture-human-record", reason: "fixture only", humanSeconds: 20, signature: "" };
  r.signature = sign(null, Buffer.from(reviewPayload(r)), keys.privateKey).toString("base64");
  const confirmed: EvidenceBundle = { ...bundle, status: "business_confirmed", confirmationRef: r.sourceRef, review: r };
  assert.equal(importEvidence(confirmed, dir, trust).ok, true);
  const req = { registry: { "fixture-business": "0x0000000000000000000000000000000000000001" as const }, chainId: 5042002, contract: "0x0000000000000000000000000000000000000002" as const, token: "0x3600000000000000000000000000000000000000" as const, ruleVersion: keccak256(toBytes(RULE_LABEL)), ttlSeconds: 300 };
  const verifierKey = generatePrivateKey();
  assert.equal((await signBusinessCase(confirmed, dir, trust, req, verifierKey)).signed, true);
  assert.equal((await signBusinessCase(bundle, dir, trust, req, verifierKey)).signed, false);
  assert.equal((await signBusinessCase(confirmed, dir, {}, req, verifierKey)).signed, false);

  assert.equal(importEvidence(confirmed, dir).ok, false);
  assert.equal(importEvidence({ ...confirmed, review: undefined }, dir, trust).ok, false);
  assert.equal(importEvidence({ ...confirmed, authorizationRef: "changed" }, dir, trust).ok, false);
  assert.equal(importEvidence({ ...confirmed, record: { ...bundle.record, counterparty: "other" } }, dir, trust).ok, false);
  assert.equal(importEvidence({ ...confirmed, review: { ...r, humanSeconds: 0 } }, dir, trust).ok, false);
  const rejected = { ...r, outcome: "rejected" as const, reason: "not approved" };
  rejected.signature = sign(null, Buffer.from(reviewPayload(rejected)), keys.privateKey).toString("base64");
  assert.equal(importEvidence({ ...confirmed, review: rejected }, dir, trust).ok, false);
  assert.equal(importEvidence({ ...bundle, review: rejected }, dir, trust).ok, true);
  const run = (script: string, args: string[], env = process.env) => execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)), fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), ...args], { cwd: dir, env, stdio: "pipe" }).toString();
  for (const [file, content] of [["bundle.json", bundle], ["review.json", r], ["reject.json", rejected], ["trust.json", trust]] as const) writeFileSync(join(dir, file), JSON.stringify(content));
  assert.throws(() => run("review-evidence.ts", ["bundle.json", "review.json", "trust.json", "confirmed.json"], { ...process.env, REVIEW_TEST_FAIL_AFTER_OUTPUT: "1" }));
  assert.equal(readLog(join(dir, "human-reviews.jsonl")).length, 0);
  run("review-evidence.ts", ["bundle.json", "review.json", "trust.json", "confirmed.json"]);
  assert.match(run("review-evidence.ts", ["bundle.json", "review.json", "trust.json", "confirmed.json"]), /"alreadyRecorded":true/);
  mkdirSync(join(dir, ".human-reviews.lock"));
  assert.throws(() => run("review-evidence.ts", ["bundle.json", "reject.json", "trust.json", "rejected.json"]));
  rmSync(join(dir, ".human-reviews.lock"), { recursive: true });
  run("review-evidence.ts", ["bundle.json", "reject.json", "trust.json", "rejected.json"]);
  assert.equal(readLog(join(dir, "human-reviews.jsonl")).length, 2);
  assert.equal(verify(readLog(join(dir, "human-reviews.jsonl"))).ok, true);
  assert.throws(() => run("review-evidence.ts", ["bundle.json", "review.json", "trust.json", "duplicate.json"]));
  if (process.platform === "darwin") {
    const secret = join(dir, "fixture-key.txt");
    writeFileSync(secret, "fixture only");
    const read = `require('fs').readFileSync(${JSON.stringify(secret)}, 'utf8')`;
    assert.equal(execFileSync(process.execPath, ["-e", `process.stdout.write(${read})`]).toString(), "fixture only");
    const probe = `require('fs').readFileSync('source.txt');let blocked=false;try{${read}}catch(e){blocked=e.code==='EPERM'||e.code==='EACCES'}if(!blocked)process.exit(1);console.log('isolated')`;
    assert.match(run("isolate-agent.ts", [process.execPath, "-e", probe], { ...process.env, VERIFIER_ENV_FILE: secret }), /isolated/);
  }
  const log = join(dir, "log.jsonl");
  const entry = { day: "fixture", caseId: bundle.record.caseId, kind: "escalated" as const, by: "person" as const, summary: "fixture", detail: { reviewHash: r.bundleHash, outcome: rejected.outcome } };
  append(log, entry);
  const c = prepareCheckpoint(log, "fixture-log");
  assert.equal(verifyCheckpoint(log, c), true);
  append(log, { ...entry, summary: "follow-up" });
  assert.equal(verifyCheckpoint(log, c), true);
  // A consistently rewritten chain passes its internal hashes but fails an independently retained checkpoint.
  writeFileSync(log, "");
  append(log, { ...entry, summary: "rewritten history" });
  assert.equal(verifyCheckpoint(log, c), false);
  console.log("business review CLI, tampering, duplicate guard, sandbox and independent checkpoint controls passed (synthetic fixtures)");
} finally { rmSync(dir, { recursive: true, force: true }); }
