import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { canonicalJson, type CaseRecord, type ObservedFact } from "./case.js";

export type SourceArtifact = {
  id: string;
  path: string;
  sha256: string;
  capturedAt: string;
  /** A durable pointer to the source row, export, or measurement protocol. */
  provenance: string;
};

export type EvidenceBundle = {
  status: "synthetic" | "self_test" | "business_unconfirmed" | "business_confirmed" | "historical_replay";
  /** Private reference to the permission for using the records in this project. */
  authorizationRef?: string;
  /** Private reference to the business user's confirmation, if one exists. */
  confirmationRef?: string;
  artifacts: SourceArtifact[];
  record: CaseRecord;
};

export type ImportResult = { ok: true; record: CaseRecord; status: EvidenceBundle["status"] } | { ok: false; errors: string[] };

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const positiveInt = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const finiteNonnegative = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Shared pre-decision snapshot ID for the three-policy comparison. */
export function factSnapshotHash(record: CaseRecord): string {
  const observed = record.observed.map(canonicalJson).sort();
  return createHash("sha256").update(canonicalJson({
    caseId: record.caseId,
    kind: record.kind,
    counterparty: record.counterparty,
    observed,
  })).digest("hex");
}

/**
 * Accept only source-backed facts. This guard does not certify that the source
 * is truthful or that its owner approved publication; those remain human acts.
 * Raw exports and the bundle belong in ignored private-data/, not in git.
 */
export function importEvidence(bundle: EvidenceBundle, baseDir: string): ImportResult {
  const errors: string[] = [];
  if (!bundle || !bundle.record || !Array.isArray(bundle.record.observed) || !Array.isArray(bundle.artifacts)) {
    return { ok: false, errors: ["missing record, observed facts, or artifacts"] };
  }
  if (!/^(synthetic|self_test|business_unconfirmed|business_confirmed|historical_replay)$/.test(bundle.status)) errors.push("invalid evidence status");
  if ((bundle.status.startsWith("business") || bundle.status === "historical_replay") && !bundle.authorizationRef?.trim()) errors.push("business data requires an authorization reference");
  if (bundle.status === "business_confirmed" && !bundle.confirmationRef?.trim()) errors.push("confirmed business use requires a confirmation reference");
  if (!bundle.record.observed.length) errors.push("case has no observed facts");
  if (!/^0x[0-9a-fA-F]{64}$/.test(bundle.record.caseId)) errors.push("invalid case ID");
  if (!["duplicate_charge_refund", "pay_undisputed", "tenant_credit_undelivered"].includes(bundle.record.kind)) errors.push("invalid case kind");
  if (!bundle.record.counterparty?.trim()) errors.push("missing counterparty");

  const byId = new Map<string, SourceArtifact>();
  for (const artifact of bundle.artifacts) {
    if (!artifact.id?.trim() || byId.has(artifact.id)) { errors.push("empty or duplicate artifact ID"); continue; }
    byId.set(artifact.id, artifact);
    if (!artifact.provenance?.trim() || !Number.isFinite(Date.parse(artifact.capturedAt))) errors.push(`${artifact.id}: missing provenance or valid capture time`);
    if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) { errors.push(`${artifact.id}: invalid SHA-256`); continue; }
    try {
      const base = realpathSync(baseDir);
      const path = realpathSync(resolve(base, artifact.path));
      const rel = relative(base, path);
      if (isAbsolute(artifact.path) || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
        errors.push(`${artifact.id}: source file must stay beside the private bundle`);
        continue;
      }
      const actual = sha256(readFileSync(path));
      if (actual !== artifact.sha256) errors.push(`${artifact.id}: source file hash changed`);
    } catch { errors.push(`${artifact.id}: source file unavailable`); }
  }

  const refs = new Set<string>();
  for (const fact of bundle.record.observed as ObservedFact[]) {
    if (!fact || !["upstream_order", "vendor_charge", "delivery_measured", "delivery_unmeasurable", "tenant_debit", "job_failed", "gateway_settlement", "duplicate_intent_assessment"].includes(fact.kind)) { errors.push("unknown observed fact kind"); continue; }
    if (fact.kind === "gateway_settlement" && (!finiteNonnegative(fact.requestedSeconds) || !finiteNonnegative(fact.reportedSeconds) || !fact.jobRef?.trim())) errors.push(`${fact.ref}: invalid gateway duration or job reference`);
    if (!byId.has(fact.source)) errors.push(`${fact.ref}: source artifact ${fact.source} is missing`);
    if (!fact.ref?.trim() || refs.has(`${fact.source}:${fact.ref}`)) errors.push("empty or duplicate fact reference");
    refs.add(`${fact.source}:${fact.ref}`);
    if ("settledMicro" in fact && (!Number.isSafeInteger(fact.settledMicro) || fact.settledMicro < 0)) errors.push(`${fact.ref}: invalid settledMicro`);
    if ("originTime" in fact && !Number.isFinite(Date.parse(fact.originTime))) errors.push(`${fact.ref}: invalid original timestamp`);
    if ("chargedMicro" in fact && !positiveInt(fact.chargedMicro)) errors.push(`${fact.ref}: chargedMicro must be a positive safe integer`);
    if ("debitedMicro" in fact && !positiveInt(fact.debitedMicro)) errors.push(`${fact.ref}: debitedMicro must be a positive safe integer`);
    if ("submittedAtMs" in fact && !positiveInt(fact.submittedAtMs)) errors.push(`${fact.ref}: invalid submittedAtMs`);
    if ("billedSeconds" in fact && !finiteNonnegative(fact.billedSeconds)) errors.push(`${fact.ref}: invalid billedSeconds`);
    if ("measuredSeconds" in fact && !finiteNonnegative(fact.measuredSeconds)) errors.push(`${fact.ref}: invalid measuredSeconds`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, record: bundle.record, status: bundle.status };
}
