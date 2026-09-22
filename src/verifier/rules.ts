import type { Address } from "viem";
import type {
  CaseRecord,
  DeliveryMeasured,
  DeliveryUnmeasurable,
  JobFailed,
  TenantDebit,
  UpstreamOrder,
  VendorCharge,
} from "../evidence/case.js";

/**
 * The verifier's rules, version 1.
 *
 * These run in the verifier's process, not the agent's. They look only at the
 * observed layer of a case and work out, by themselves, the most that may be
 * paid. The agent never tells the verifier a number; the verifier computes
 * its own ceiling, and the contract refuses anything above it.
 *
 * When the facts do not settle the question, the answer is a refusal to sign,
 * with the reason. A person picks it up from there.
 */

export const RULE_LABEL = "agoranomos-rules-v1";

/**
 * Two orders count as one piece of work submitted twice when they carry the
 * same request fingerprint within this window.
 */
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * A delivered clip is accepted as the length billed when it is at most this
 * much shorter. Encoders round frame boundaries; this is not a discount.
 */
export const DURATION_TOLERANCE_SECONDS = 0.5;

/**
 * Who each counterparty is paid at. Kept by the verifier, not supplied by the
 * agent, so a case cannot redirect money by naming a different address.
 */
export type PayeeRegistry = Record<string, Address>;

export type Verdict =
  | { sign: true; maxMicro: number; payee: Address; basis: string[] }
  | { sign: false; reasons: string[] };

export function judge(record: CaseRecord, registry: PayeeRegistry): Verdict {
  const payee = registry[record.counterparty];
  if (!payee) {
    return { sign: false, reasons: [`no payment address is registered for ${record.counterparty}`] };
  }
  switch (record.kind) {
    case "duplicate_charge_refund":
      return duplicateCharge(record, payee);
    case "pay_undisputed":
      return payUndisputed(record, payee);
    case "tenant_credit_undelivered":
      return tenantCredit(record, payee);
  }
}

function duplicateCharge(record: CaseRecord, payee: Address): Verdict {
  const orders = record.observed.filter((f): f is UpstreamOrder => f.kind === "upstream_order");
  const byFingerprint = new Map<string, UpstreamOrder[]>();
  for (const o of orders) {
    byFingerprint.set(o.requestFingerprint, [...(byFingerprint.get(o.requestFingerprint) ?? []), o]);
  }

  let maxMicro = 0;
  const basis: string[] = [];
  for (const [fingerprint, group] of byFingerprint) {
    const sorted = [...group].sort((a, b) => a.submittedAtMs - b.submittedAtMs);
    const distinctTasks = new Set(sorted.map((o) => o.taskId));
    if (distinctTasks.size < 2) continue;
    const first = sorted[0];
    for (const later of sorted.slice(1)) {
      if (later.taskId === first.taskId) continue;
      if (later.submittedAtMs - first.submittedAtMs > DUPLICATE_WINDOW_MS) continue;
      if (later.chargedMicro <= 0) continue;
      // The first order is the one that was asked for. Every later one with
      // the same fingerprint inside the window is the same work, paid again.
      maxMicro += later.chargedMicro;
      basis.push(`${later.taskId} repeats ${first.taskId} (fingerprint ${fingerprint.slice(0, 12)}) and was charged ${later.chargedMicro}`);
    }
  }

  if (maxMicro === 0) {
    return { sign: false, reasons: ["no two distinct orders share a fingerprint inside the window, so there is no observed duplicate"] };
  }
  return { sign: true, maxMicro, payee, basis };
}

function payUndisputed(record: CaseRecord, payee: Address): Verdict {
  const charges = record.observed.filter((f): f is VendorCharge => f.kind === "vendor_charge");
  const measured = new Map(
    record.observed
      .filter((f): f is DeliveryMeasured => f.kind === "delivery_measured")
      .map((f) => [f.jobRef, f]),
  );
  const unmeasurable = new Set(
    record.observed
      .filter((f): f is DeliveryUnmeasurable => f.kind === "delivery_unmeasurable")
      .map((f) => f.jobRef),
  );

  let maxMicro = 0;
  const basis: string[] = [];
  const withheld: string[] = [];
  for (const c of charges) {
    const m = measured.get(c.jobRef);
    if (!m) {
      withheld.push(
        unmeasurable.has(c.jobRef)
          ? `${c.ref}: the delivery could not be measured, so it is neither confirmed nor disputed`
          : `${c.ref}: no delivery on record for this charge`,
      );
      continue;
    }
    if (m.measuredSeconds + DURATION_TOLERANCE_SECONDS < c.billedSeconds) {
      withheld.push(`${c.ref}: billed ${c.billedSeconds}s, delivered ${m.measuredSeconds}s`);
      continue;
    }
    maxMicro += c.chargedMicro;
    basis.push(`${c.ref}: billed ${c.billedSeconds}s, delivered ${m.measuredSeconds}s`);
  }

  if (maxMicro === 0) {
    return { sign: false, reasons: withheld.length ? withheld : ["no charges in this case"] };
  }
  return { sign: true, maxMicro, payee, basis: [...basis, ...withheld.map((w) => `withheld ${w}`)] };
}

function tenantCredit(record: CaseRecord, payee: Address): Verdict {
  const debits = record.observed.filter((f): f is TenantDebit => f.kind === "tenant_debit");
  const failed = new Set(
    record.observed.filter((f): f is JobFailed => f.kind === "job_failed").map((f) => f.jobRef),
  );

  let maxMicro = 0;
  const basis: string[] = [];
  const notCredited: string[] = [];
  for (const d of debits) {
    if (failed.has(d.jobRef)) {
      maxMicro += d.debitedMicro;
      basis.push(`${d.ref}: debited ${d.debitedMicro} for a job recorded as failed`);
    } else {
      notCredited.push(`${d.ref}: the job is not recorded as failed`);
    }
  }

  if (maxMicro === 0) {
    return { sign: false, reasons: notCredited.length ? notCredited : ["no debits in this case"] };
  }
  return { sign: true, maxMicro, payee, basis };
}
