import { readFileSync } from "node:fs";

const policies = ["fixed", "fixed_probe", "adaptive"] as const;
type Policy = (typeof policies)[number];
type Row = {
  day: string;
  caseId: string;
  policy: Policy;
  evidenceRefs: string[];
  probeCount: number;
  probeCostMicro: number;
  outcome: "resolved" | "escalated";
  adjudication: "upheld" | "overturned" | "pending";
  humanSeconds: number | null;
};

function fail(message: string): never { throw new Error(message); }
function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const path = process.argv[2];
if (!path) fail("usage: npm run score:comparison -- path/to/rows.json");
const input: unknown = JSON.parse(readFileSync(path, "utf8"));
if (!Array.isArray(input)) fail("input must be a JSON array");
const rows: Row[] = [];
const groups = new Map<string, Set<Policy>>();

for (const [index, value] of input.entries()) {
  const r = value as Partial<Row>;
  const label = `row ${index + 1}`;
  if (!r || typeof r !== "object") fail(`${label}: expected an object`);
  if (typeof r.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.day)) fail(`${label}: bad day`);
  if (typeof r.caseId !== "string" || !r.caseId.trim()) fail(`${label}: missing caseId`);
  if (r.policy !== "fixed" && r.policy !== "fixed_probe" && r.policy !== "adaptive") fail(`${label}: bad policy`);
  if (!Array.isArray(r.evidenceRefs) || !r.evidenceRefs.length || r.evidenceRefs.some((x) => typeof x !== "string" || !x.trim())) fail(`${label}: missing evidenceRefs`);
  if (!nonnegativeInteger(r.probeCount) || !nonnegativeInteger(r.probeCostMicro)) fail(`${label}: bad probe count or cost`);
  if (r.outcome !== "resolved" && r.outcome !== "escalated") fail(`${label}: bad outcome`);
  if (!["upheld", "overturned", "pending"].includes(r.adjudication ?? "")) fail(`${label}: bad adjudication`);
  if (r.outcome === "escalated" && r.adjudication !== "pending") fail(`${label}: escalation cannot be adjudicated as a conclusion`);
  if (r.humanSeconds !== null && !nonnegativeInteger(r.humanSeconds)) fail(`${label}: humanSeconds must be a nonnegative integer or null`);
  const key = `${r.day}|${r.caseId}`;
  const seen = groups.get(key) ?? new Set<Policy>();
  if (seen.has(r.policy)) fail(`${label}: duplicate ${r.policy} for ${key}`);
  seen.add(r.policy);
  groups.set(key, seen);
  rows.push(r as Row);
}

for (const [key, seen] of groups) {
  if (seen.size !== policies.length) fail(`${key}: expected all three policies, got ${[...seen].join(", ")}`);
}

const result = policies.map((policy) => {
  const rs = rows.filter((r) => r.policy === policy);
  const n = rs.length;
  const resolved = rs.filter((r) => r.outcome === "resolved");
  const adjudicated = resolved.filter((r) => r.adjudication !== "pending");
  const overturned = adjudicated.filter((r) => r.adjudication === "overturned").length;
  const measured = rs.filter((r) => r.humanSeconds !== null);
  const probeCount = rs.reduce((s, r) => s + r.probeCount, 0);
  const probeCostMicro = rs.reduce((s, r) => s + r.probeCostMicro, 0);
  return {
    policy,
    caseDays: n,
    evidence: { probeCount, probeCostMicro, probesPerCase: n ? probeCount / n : null, costMicroPerCase: n ? probeCostMicro / n : null },
    overturnedConclusions: { overturned, adjudicated: adjudicated.length, pending: resolved.length - adjudicated.length, rate: adjudicated.length ? overturned / adjudicated.length : null },
    autonomousResolution: { resolved: resolved.length, total: n, share: n ? resolved.length / n : null },
    humanTime: { observedSeconds: measured.reduce((s, r) => s + (r.humanSeconds ?? 0), 0), measuredRows: measured.length, missingRows: n - measured.length },
  };
});

process.stdout.write(`${JSON.stringify({ caseDays: groups.size, policies: result }, null, 2)}\n`);
