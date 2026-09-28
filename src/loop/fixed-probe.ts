import type { Discrepancy, Hypothesis, Policy, ProbeOption, Proposal } from "./day.js";

/**
 * A static evidence-collection control. It uses a fixed option order, never
 * looks at competing hypotheses, and stays within the same probe budget as
 * the adaptive policy. Probe execution remains the caller's responsibility.
 */
export class FixedProbePolicy implements Policy {
  readonly name = "fixed_probe";
  readonly by = "code" as const;

  explain(d: Discrepancy, hypotheses: Hypothesis[]) {
    return { summary: `static review of ${d.line}; no hypothesis-driven probe selection`, hypotheses };
  }

  chooseProbes(options: ProbeOption[], _hypotheses: Hypothesis[], budgetMicro: number) {
    const chosen: ProbeOption[] = [];
    const lines = new Set<string>();
    let remaining = budgetMicro;
    for (const option of options) {
      if (lines.has(option.line) || !Number.isSafeInteger(option.costMicro) || option.costMicro < 0 || option.costMicro > remaining) continue;
      chosen.push(option);
      lines.add(option.line);
      remaining -= option.costMicro;
    }
    return { chosen, reason: `static first-affordable probe per line; ${chosen.length} selected` };
  }

  propose(d: Discrepancy): Proposal {
    if (d.interval.lowMicro !== d.interval.highMicro || !d.record) {
      return { caseId: d.caseId, action: "no_action", record: null, reason: "uncertain or no verifier-ready record; escalate" };
    }
    return { caseId: d.caseId, action: "pay", record: d.record, reason: "single observed amount, candidate for independent verifier" };
  }
}
