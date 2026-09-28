import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseIdFor } from "../src/evidence/case.js";
import { factSnapshotHash, importEvidence, type EvidenceBundle } from "../src/evidence/import.js";

const root = mkdtempSync(join(tmpdir(), "agoranomos-evidence-"));
const dir = join(root, "private-data");
mkdirSync(dir);
try {
  const bytes = Buffer.from("source row 1\n");
  writeFileSync(join(dir, "source.txt"), bytes);
  const base: EvidenceBundle = {
    status: "self_test",
    artifacts: [{ id: "test-export", path: "source.txt", sha256: createHash("sha256").update(bytes).digest("hex"), capturedAt: "2026-09-28T00:00:00Z", provenance: "row 1 of local mechanism fixture" }],
    record: { caseId: caseIdFor(["import-test"]), kind: "tenant_credit_undelivered", counterparty: "test", observed: [{ kind: "tenant_debit", source: "test-export", ref: "row-1", jobRef: "j1", debitedMicro: 100_000 }], contract: [], inference: [] },
  };
  assert.equal(importEvidence(base, dir).ok, true);
  assert.match(factSnapshotHash(base.record), /^[0-9a-f]{64}$/);
  assert.match(JSON.stringify(importEvidence({ ...base, status: "business_confirmed" }, dir)), /authorization reference/);
  assert.match(JSON.stringify(importEvidence({ ...base, status: "business_confirmed", authorizationRef: "approval" }, dir)), /confirmation reference/);
  writeFileSync(join(dir, "source.txt"), "tampered\n");
  assert.match(JSON.stringify(importEvidence(base, dir)), /source file hash changed/);
  const missing = { ...base, record: { ...base.record, observed: [{ ...base.record.observed[0], source: "other" }] } } as EvidenceBundle;
  assert.match(JSON.stringify(importEvidence(missing, dir)), /source artifact other is missing/);
  const escaped = { ...base, artifacts: [{ ...base.artifacts[0], path: "../outside.txt" }] };
  writeFileSync(join(root, "outside.txt"), bytes);
  assert.match(JSON.stringify(importEvidence(escaped, dir)), /source file must stay beside/);
  console.log("evidence import: 7 checks passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
