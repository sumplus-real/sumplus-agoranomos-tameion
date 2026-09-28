import { canonicalJson, type CaseRecord, type Inference, type ObservedFact } from "../evidence/case.js";
import { append } from "./decision-log.js";

/**
 * One day of the loop.
 *
 * The steps are fixed; what happens inside them is not. Each step that calls
 * for judgement goes through a Policy, and the day records which party made
 * each call. Two policies exist so they can be compared on the same days:
 *
 *   FixedPolicy     the baseline: the same checks every day, no probes chosen,
 *                   every open question escalated
 *   a reasoning policy, which plugs in behind the same interface and is
 *                   judged against the baseline on cost, false alarms and the
 *                   share of cases it can settle
 *
 * Arithmetic never goes through a policy. Money never moves because a policy
 * said so: a proposal becomes a case, the verifier decides whether to sign
 * it, and the contract decides whether to pay it.
 */

/** A line's competing explanations of how it actually charges. */
export type Hypothesis = {
  id: string;
  statement: string;
  /** How the evidence so far bears on it, as a range rather than a point. */
  support: { low: number; high: number };
  evidence: string[];
};

/** A measurement the loop could run next, with what it would cost. */
export type ProbeOption = {
  id: string;
  line: string;
  description: string;
  costMicro: number;
  /** Which hypotheses its outcome could tell apart. */
  separates: string[];
};

export type Discrepancy = {
  line: string;
  caseId: string;
  observed: ObservedFact[];
  /** What the observed layer alone supports, as a range. */
  interval: Inference;
  /** Optional evidence package for a proposed action; the verifier still judges it independently. */
  record?: CaseRecord;
};

export type Proposal = {
  caseId: string;
  action: "pay" | "hold" | "dispute" | "refund" | "reroute" | "no_action";
  record: CaseRecord | null;
  reason: string;
};

export interface Policy {
  readonly name: string;
  /** The actual decision maker. A deterministic adaptive rule is code, not a model. */
  readonly by?: "code" | "model";
  /** Explain a discrepancy under the current hypotheses. */
  explain(d: Discrepancy, hypotheses: Hypothesis[]): { summary: string; hypotheses: Hypothesis[] };
  /** Pick the next probes within the day's budget, or none. */
  chooseProbes(options: ProbeOption[], hypotheses: Hypothesis[], budgetMicro: number): { chosen: ProbeOption[]; reason: string };
  /** Turn what is known into proposals. Escalate what it cannot settle. */
  propose(d: Discrepancy, hypotheses: Hypothesis[]): Proposal;
}

/**
 * The baseline. It does what a scheduled job does: runs the same checks,
 * never spends on evidence, and hands every open question to a person.
 */
export class FixedPolicy implements Policy {
  readonly name = "fixed";

  explain(d: Discrepancy, hypotheses: Hypothesis[]) {
    return {
      summary: `observed range ${d.interval.lowMicro}..${d.interval.highMicro} on ${d.line}; no interpretation attempted`,
      hypotheses,
    };
  }

  chooseProbes(_options: ProbeOption[], _hypotheses: Hypothesis[], _budgetMicro: number) {
    return { chosen: [], reason: "the fixed policy never spends on evidence" };
  }

  propose(d: Discrepancy): Proposal {
    const settled = d.interval.lowMicro === d.interval.highMicro && d.interval.lowMicro > 0;
    const recordMatches = !!d.record && d.record.caseId === d.caseId && d.record.observed.length > 0 &&
      canonicalJson(d.record.observed.map(canonicalJson).sort()) === canonicalJson(d.observed.map(canonicalJson).sort());
    const candidate = settled && recordMatches;
    return {
      caseId: d.caseId,
      action: candidate ? "pay" : "no_action",
      record: candidate ? d.record! : null,
      reason: candidate
        ? "candidate only: observed range is a single value; independent verifier must determine the ceiling"
        : "the observed range or matching case record is incomplete; left for a person",
    };
  }
}

export type DayInput = {
  day: string;
  logPath: string;
  policy: Policy;
  discrepancies: Discrepancy[];
  probeOptions: ProbeOption[];
  hypotheses: Hypothesis[];
  probeBudgetMicro: number;
  /** Omit to recommend probes only, with no external calls or spending. */
  executeProbe?: ProbeExecutor;
};

export type DayResult = {
  /** Final records actually observed on this policy path, in discrepancy order. */
  observedRecords: (CaseRecord | null)[];
  proposals: Proposal[];
  probesChosen: ProbeOption[];
  probesExecuted: number;
  /** Null means the executor failed after external cost may have been incurred. */
  probeSpentMicro: number | null;
  escalations: number;
};

export type ProbeOutcome =
  | {
      status: "observed";
      caseId: string;
      /** New observed facts, with source and reference, returned by the executor. */
      addedFacts: ObservedFact[];
      /** Optional revised estimate, based on the new facts. */
      interval?: Inference;
      /** Optional revised, explicit support ranges. */
      hypotheses?: Hypothesis[];
      /** A new matching record is required before a changed case can be proposed. */
      record?: CaseRecord;
      actualCostMicro: number;
      reason: string;
    }
  | { status: "failed"; caseId: string; actualCostMicro: number; reason: string };

/** The caller enforces the quoted cost at its external gateway. This loop makes no calls itself. */
export type ProbeExecutor = (option: ProbeOption, budgetRemainingMicro: number) => ProbeOutcome;

export function runDay(input: DayInput): DayResult {
  const { day, logPath, policy } = input;
  if (!Number.isSafeInteger(input.probeBudgetMicro) || input.probeBudgetMicro < 0) {
    throw new Error("probe budget must be a nonnegative integer");
  }
  const options = input.probeOptions;
  if (options.some((p) => !Number.isSafeInteger(p.costMicro) || p.costMicro < 0)) {
    throw new Error("probe cost must be a nonnegative integer");
  }
  if (new Set(options.map((p) => p.id)).size !== options.length) {
    throw new Error("probe option IDs must be unique");
  }
  let hypotheses = input.hypotheses;
  const cases = input.discrepancies.map((d) => ({ ...d, observed: [...d.observed] }));
  const blocked = new Set<string>();

  for (const d of cases) {
    append(logPath, {
      day,
      caseId: d.caseId,
      kind: "measured",
      by: "code",
      summary: `${d.line}: observed range ${d.interval.lowMicro}..${d.interval.highMicro}`,
      detail: { facts: d.observed.length, basis: d.interval.basis },
    });

    const explained = policy.explain(d, hypotheses);
    hypotheses = explained.hypotheses;
    append(logPath, {
      day,
      caseId: d.caseId,
      kind: "explained",
      by: policy.by ?? "code",
      summary: explained.summary,
      detail: { policy: policy.name, hypotheses: hypotheses.map((h) => ({ id: h.id, support: h.support })) },
    });

  }

  const probes = policy.chooseProbes(options, hypotheses, input.probeBudgetMicro);
  const known = new Map(options.map((p) => [p.id, p]));
  if (new Set(probes.chosen.map((p) => p.id)).size !== probes.chosen.length ||
      probes.chosen.some((p) => known.get(p.id) !== p)) {
    throw new Error(`policy ${policy.name} chose an unknown or duplicate probe`);
  }
  const quoted = probes.chosen.reduce((s, p) => s + p.costMicro, 0);
  if (quoted > input.probeBudgetMicro) {
    // The budget is also enforced where the agent cannot reach it, at the
    // gateway key that pays for probes. This is the second, earlier refusal.
    throw new Error(`policy ${policy.name} chose ${quoted} of probes against a budget of ${input.probeBudgetMicro}`);
  }
  append(logPath, {
    day,
    caseId: null,
    kind: probes.chosen.length ? "probe_chosen" : "probe_skipped",
    by: policy.by ?? "code",
    summary: probes.reason,
    detail: { chosen: probes.chosen.map((p) => p.id), quotedMicro: quoted, spentMicro: 0, budgetMicro: input.probeBudgetMicro },
  });

  let spent = 0;
  let executed = 0;
  let costUnknown = false;
  for (const option of probes.chosen) {
    const affected = cases.filter((d) => d.line === option.line);
    affected.forEach((d) => blocked.add(d.caseId));
    if (costUnknown) {
      append(logPath, {
        day, caseId: null, kind: "probe_skipped", by: "code",
        summary: `${option.id}: execution halted after an uncertain probe cost`,
        detail: { probeId: option.id, line: option.line, actualCostMicro: "unknown" },
      });
      continue;
    }
    if (!input.executeProbe) {
      append(logPath, {
        day, caseId: null, kind: "probe_skipped", by: "code",
        summary: `${option.id}: no executor supplied; evidence remains pending`,
        detail: { probeId: option.id, line: option.line, spentMicro: 0 },
      });
      continue;
    }
    let reportedCost: number | "unknown" = "unknown";
    try {
      const outcome = input.executeProbe(option, input.probeBudgetMicro - spent);
      reportedCost = outcome.actualCostMicro;
      const target = affected.find((d) => d.caseId === outcome.caseId);
      if (!target) throw new Error("probe result names no matching case on this line");
      if (!Number.isSafeInteger(outcome.actualCostMicro) || outcome.actualCostMicro < 0 ||
          outcome.actualCostMicro > option.costMicro || spent + outcome.actualCostMicro > input.probeBudgetMicro) {
        throw new Error("probe result exceeds its quote or the day's budget");
      }
      spent += outcome.actualCostMicro;
      if (outcome.status === "failed") {
        blocked.add(target.caseId);
        append(logPath, {
          day, caseId: target.caseId, kind: "probe_failed", by: "code",
          summary: `${option.id}: ${outcome.reason}`,
          detail: { probeId: option.id, actualCostMicro: outcome.actualCostMicro },
        });
        continue;
      }
      if (outcome.interval && outcome.addedFacts.length === 0) {
        throw new Error("a revised interval requires newly observed facts");
      }
      if (outcome.addedFacts.some((f) => !f.source || !f.ref)) {
        throw new Error("probe facts require source and reference");
      }
      const observed = [...target.observed, ...outcome.addedFacts];
      if (outcome.record) {
        if (outcome.record.caseId !== target.caseId ||
            canonicalJson(outcome.record.observed.map(canonicalJson).sort()) !== canonicalJson(observed.map(canonicalJson).sort())) {
          throw new Error("probe record does not match the revised observed facts");
        }
        target.record = outcome.record;
      } else if (outcome.addedFacts.length > 0) {
        // Never submit an old evidence package after facts have changed.
        target.record = undefined;
      }
      target.observed = observed;
      if (outcome.interval) target.interval = outcome.interval;
      if (outcome.hypotheses) hypotheses = outcome.hypotheses;
      executed += 1;
      blocked.delete(target.caseId);
      append(logPath, {
        day, caseId: target.caseId, kind: "probe_result", by: "code",
        summary: `${option.id}: ${outcome.reason}`,
        detail: { probeId: option.id, actualCostMicro: outcome.actualCostMicro, addedFacts: outcome.addedFacts.map((f) => ({ source: f.source, ref: f.ref })) },
      });
      const revised = policy.explain(target, hypotheses);
      hypotheses = revised.hypotheses;
      append(logPath, {
        day, caseId: target.caseId, kind: "revised", by: policy.by ?? "code",
        summary: revised.summary,
        detail: { policy: policy.name, interval: target.interval, hypotheses: hypotheses.map((h) => ({ id: h.id, support: h.support })) },
      });
    } catch (error) {
      costUnknown = true;
      append(logPath, {
        day, caseId: null, kind: "probe_failed", by: "code",
        summary: `${option.id}: executor result rejected or failed`,
        detail: { probeId: option.id, reason: String(error), reportedCostMicro: reportedCost, actualCostMicro: "unknown" },
      });
    }
  }

  const proposals: Proposal[] = [];
  for (const d of cases) {
    const proposal = blocked.has(d.caseId)
      ? { caseId: d.caseId, action: "no_action" as const, record: null, reason: "probe pending or failed; human review required" }
      : policy.propose(d, hypotheses);
    proposals.push(proposal);
    append(logPath, {
      day,
      caseId: d.caseId,
      kind: proposal.action === "no_action" ? "escalated" : "proposed",
      by: policy.by ?? "code",
      summary: `${proposal.action}: ${proposal.reason}`,
      detail: { policy: policy.name },
    });
  }

  return {
    observedRecords: cases.map(d => d.record ?? null),
    proposals,
    probesChosen: probes.chosen,
    probesExecuted: executed,
    probeSpentMicro: costUnknown ? null : spent,
    escalations: proposals.filter((p) => p.action === "no_action").length,
  };
}
