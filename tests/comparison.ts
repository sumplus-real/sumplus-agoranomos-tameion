import assert from "node:assert/strict";
import { scoreComparison } from "../scripts/score-comparison.js";

const hash = "a".repeat(64);
const base = {
  caseDays: [{ day: "2026-09-28", caseId: "case-1", caseClass: "self_test", factSnapshotHash: hash, sourceRefs: ["private:intake:1"] }],
  rows: (["fixed", "fixed_probe", "adaptive"] as const).map((policy, index) => ({
    day: "2026-09-28", caseId: "case-1", policy, factSnapshotHash: hash,
    evidenceRefs: [`private:decision:${policy}`],
    probeCount: index, probeCostMicro: index * 10,
    outcome: index === 0 ? "escalated" as const : "resolved" as const,
    adjudication: index === 0 ? "pending" as const : "upheld" as const,
    humanSeconds: index === 2 ? null : index * 20,
  })),
};
const result = scoreComparison(base);
assert.equal(result.caseDays, 1);
assert.equal(result.rowCount, 3);
assert.equal(result.cohorts.length, 1);
assert.equal(result.cohorts[0].caseClass, "self_test");
assert.equal(result.cohorts[0].policies[0].autonomousResolution.share, 0);
assert.equal(result.cohorts[0].policies[1].evidence.probeCostMicro, 10);
assert.equal(result.cohorts[0].policies[2].humanTime.complete, false);

function rejected(name: string, input: unknown, pattern: RegExp) {
  assert.throws(() => scoreComparison(input), pattern, name);
}
rejected("empty manifest", { caseDays: [], rows: [] }, /empty/);
rejected("missing strategy", { ...base, rows: base.rows.slice(0, 2) }, /all three/);
rejected("bad calendar date", { ...base, caseDays: [{ ...base.caseDays[0], day: "2026-02-30" }] }, /calendar day/);
rejected("mismatched frozen facts", { ...base, rows: [{ ...base.rows[0], factSnapshotHash: "b".repeat(64) }, ...base.rows.slice(1)] }, /differs from manifest/);
rejected("positive probe cost with zero probes", { ...base, rows: [{ ...base.rows[0], probeCostMicro: 1 }, ...base.rows.slice(1)] }, /zero probes/);
rejected("duplicate strategy", { ...base, rows: [...base.rows, base.rows[0]] }, /duplicate/);
rejected("unlisted case", { ...base, rows: [{ ...base.rows[0], caseId: "omitted" }, ...base.rows.slice(1)] }, /absent from manifest/);
rejected("counterfactual escalation labeled wrong", { ...base, rows: [{ ...base.rows[0], adjudication: "overturned" }, ...base.rows.slice(1)] }, /escalation cannot/);
rejected("unsafe aggregate", {
  ...base,
  caseDays: [...base.caseDays, { ...base.caseDays[0], caseId: "case-2" }],
  rows: [...base.rows.map((r) => ({ ...r, probeCount: Number.MAX_SAFE_INTEGER })),
    ...base.rows.map((r) => ({ ...r, caseId: "case-2", probeCount: Number.MAX_SAFE_INTEGER }))],
}, /safe integer range/);
console.log("comparison scorer: valid and invalid inputs passed");
