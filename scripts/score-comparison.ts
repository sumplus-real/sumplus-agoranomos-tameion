import { readFileSync } from "node:fs";

const policies = ["fixed", "fixed_probe", "adaptive"] as const;
const caseClasses = ["real_business", "self_test", "synthetic", "historical_replay"] as const;
type Policy = (typeof policies)[number];
type CaseClass = (typeof caseClasses)[number];
type CaseDay = {
  day: string;
  caseId: string;
  caseClass: CaseClass;
  factSnapshotHash: string;
  sourceRefs: string[];
};
type Row = {
  day: string;
  caseId: string;
  policy: Policy;
  factSnapshotHash: string;
  evidenceRefs: string[];
  probeCount: number;
  probeCostMicro: number;
  outcome: "resolved" | "escalated";
  adjudication: "upheld" | "overturned" | "pending";
  humanSeconds: number | null;
};
type Input = { caseDays: CaseDay[]; rows: Row[] };

function fail(message: string): never { throw new Error(message); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function validRefs(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v.trim().length > 0);
}
function sumSafe(values: number[], label: string): number {
  return values.reduce((sum, value) => {
    const next = sum + value;
    if (!Number.isSafeInteger(next)) fail(`${label}: sum exceeds safe integer range`);
    return next;
  }, 0);
}
function key(day: string, caseId: string): string { return JSON.stringify([day, caseId]); }

export function scoreComparison(value: unknown) {
  if (!record(value) || !Array.isArray(value.caseDays) || !Array.isArray(value.rows)) {
    fail("input must be an object with caseDays and rows arrays");
  }
  const input = value as Input;
  if (input.caseDays.length === 0) fail("caseDays is empty; no comparison result exists yet");
  const cases = new Map<string, CaseDay>();
  for (const [index, caseDay] of input.caseDays.entries()) {
    const label = `caseDays[${index}]`;
    if (!record(caseDay)) fail(`${label}: expected object`);
    if (!validDay(caseDay.day)) fail(`${label}: invalid calendar day`);
    if (typeof caseDay.caseId !== "string" || !caseDay.caseId.trim()) fail(`${label}: missing caseId`);
    if (!caseClasses.includes(caseDay.caseClass)) fail(`${label}: bad caseClass`);
    if (!validHash(caseDay.factSnapshotHash)) fail(`${label}: expected lowercase SHA-256 factSnapshotHash`);
    if (!validRefs(caseDay.sourceRefs)) fail(`${label}: missing sourceRefs`);
    const id = key(caseDay.day, caseDay.caseId);
    if (cases.has(id)) fail(`${label}: duplicate case-day ${id}`);
    cases.set(id, caseDay);
  }

  const seen = new Map<string, Set<Policy>>();
  for (const [index, row] of input.rows.entries()) {
    const label = `rows[${index}]`;
    if (!record(row)) fail(`${label}: expected object`);
    if (!validDay(row.day)) fail(`${label}: invalid calendar day`);
    if (typeof row.caseId !== "string" || !row.caseId.trim()) fail(`${label}: missing caseId`);
    const id = key(row.day, row.caseId);
    const caseDay = cases.get(id);
    if (!caseDay) fail(`${label}: case-day ${id} absent from manifest`);
    if (!policies.includes(row.policy)) fail(`${label}: bad policy`);
    if (row.factSnapshotHash !== caseDay.factSnapshotHash) fail(`${label}: factSnapshotHash differs from manifest`);
    if (!validRefs(row.evidenceRefs)) fail(`${label}: missing evidenceRefs`);
    if (!nonnegativeInteger(row.probeCount) || !nonnegativeInteger(row.probeCostMicro)) fail(`${label}: bad probe count or cost`);
    if (row.probeCount === 0 && row.probeCostMicro !== 0) fail(`${label}: positive probe cost with zero probes`);
    if (row.outcome !== "resolved" && row.outcome !== "escalated") fail(`${label}: bad outcome`);
    if (row.adjudication !== "upheld" && row.adjudication !== "overturned" && row.adjudication !== "pending") fail(`${label}: bad adjudication`);
    if (row.outcome === "escalated" && row.adjudication !== "pending") fail(`${label}: escalation cannot be adjudicated as a conclusion`);
    if (row.humanSeconds !== null && !nonnegativeInteger(row.humanSeconds)) fail(`${label}: humanSeconds must be nonnegative integer or null`);
    const group = seen.get(id) ?? new Set<Policy>();
    if (group.has(row.policy)) fail(`${label}: duplicate ${row.policy} for ${id}`);
    group.add(row.policy);
    seen.set(id, group);
  }
  for (const id of cases.keys()) {
    if (seen.get(id)?.size !== policies.length) fail(`${id}: expected exactly all three policies`);
  }

  const cohorts = caseClasses.filter((caseClass) => input.caseDays.some((c) => c.caseClass === caseClass)).map((caseClass) => {
    const ids = new Set(input.caseDays.filter((c) => c.caseClass === caseClass).map((c) => key(c.day, c.caseId)));
    const rows = input.rows.filter((r) => ids.has(key(r.day, r.caseId)));
    const scoredPolicies = policies.map((policy) => {
      const rs = rows.filter((r) => r.policy === policy);
      const n = rs.length;
      const resolved = rs.filter((r) => r.outcome === "resolved");
      const adjudicated = resolved.filter((r) => r.adjudication !== "pending");
      const overturned = adjudicated.filter((r) => r.adjudication === "overturned").length;
      const measured = rs.filter((r) => r.humanSeconds !== null);
      const probeCount = sumSafe(rs.map((r) => r.probeCount), "probeCount");
      const probeCostMicro = sumSafe(rs.map((r) => r.probeCostMicro), "probeCostMicro");
      return {
        policy,
        caseDays: n,
        evidence: { probeCount, probeCostMicro, probesPerCase: probeCount / n, costMicroPerCase: probeCostMicro / n },
        overturnedConclusions: { overturned, adjudicated: adjudicated.length, pending: resolved.length - adjudicated.length, rate: adjudicated.length ? overturned / adjudicated.length : null },
        autonomousResolution: { resolved: resolved.length, total: n, share: resolved.length / n },
        humanTime: { observedSeconds: sumSafe(measured.map((r) => r.humanSeconds ?? 0), "humanSeconds"), measuredRows: measured.length, missingRows: n - measured.length, complete: measured.length === n },
      };
    });
    return { caseClass, caseDays: ids.size, policies: scoredPolicies };
  });
  return { caseDays: cases.size, rowCount: input.rows.length, cohorts };
}

const path = process.argv[2];
if (process.argv[1]?.endsWith("score-comparison.ts") && path) {
  const input: unknown = JSON.parse(readFileSync(path, "utf8"));
  process.stdout.write(`${JSON.stringify(scoreComparison(input), null, 2)}\n`);
} else if (process.argv[1]?.endsWith("score-comparison.ts")) {
  fail("usage: npm run score:comparison -- path/to/comparison.json");
}
