import type { CaseRecord, Inference, ObservedFact } from "../evidence/case.js";
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
};

export type Proposal = {
  caseId: string;
  action: "pay" | "hold" | "dispute" | "refund" | "reroute" | "no_action";
  record: CaseRecord | null;
  reason: string;
};

export interface Policy {
  readonly name: string;
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
    const settled = d.interval.lowMicro === d.interval.highMicro;
    return {
      caseId: d.caseId,
      action: settled ? "pay" : "no_action",
      record: null,
      reason: settled
        ? "the observed range is a single value"
        : "the observed range is open; left for a person",
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
};

export type DayResult = {
  proposals: Proposal[];
  probesChosen: ProbeOption[];
  escalations: number;
};

export function runDay(input: DayInput): DayResult {
  const { day, logPath, policy } = input;
  let hypotheses = input.hypotheses;
  const proposals: Proposal[] = [];

  for (const d of input.discrepancies) {
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
      by: policy.name === "fixed" ? "code" : "model",
      summary: explained.summary,
      detail: { policy: policy.name, hypotheses: hypotheses.map((h) => ({ id: h.id, support: h.support })) },
    });

    const proposal = policy.propose(d, hypotheses);
    proposals.push(proposal);
    append(logPath, {
      day,
      caseId: d.caseId,
      kind: proposal.action === "no_action" ? "escalated" : "proposed",
      by: policy.name === "fixed" ? "code" : "model",
      summary: `${proposal.action}: ${proposal.reason}`,
      detail: { policy: policy.name },
    });
  }

  const probes = policy.chooseProbes(input.probeOptions, hypotheses, input.probeBudgetMicro);
  const spent = probes.chosen.reduce((s, p) => s + p.costMicro, 0);
  if (spent > input.probeBudgetMicro) {
    // The budget is also enforced where the agent cannot reach it, at the
    // gateway key that pays for probes. This is the second, earlier refusal.
    throw new Error(`policy ${policy.name} chose ${spent} of probes against a budget of ${input.probeBudgetMicro}`);
  }
  append(logPath, {
    day,
    caseId: null,
    kind: probes.chosen.length ? "probe_chosen" : "probe_skipped",
    by: policy.name === "fixed" ? "code" : "model",
    summary: probes.reason,
    detail: { chosen: probes.chosen.map((p) => p.id), spentMicro: spent, budgetMicro: input.probeBudgetMicro },
  });

  return {
    proposals,
    probesChosen: probes.chosen,
    escalations: proposals.filter((p) => p.action === "no_action").length,
  };
}
