import { canonicalJson } from "../evidence/case.js";
import type { Discrepancy, Hypothesis, Policy, ProbeOption, Proposal } from "./day.js";

/**
 * A deterministic, inspectable adaptive policy. It chooses evidence that
 * separates currently plausible explanations, then makes only a candidate
 * recommendation. It never signs, approves, or submits a payment.
 *
 * The support ranges are analyst inputs, not model probabilities. The policy
 * does not update them without an observed probe result; a later run must be
 * given the new facts and revised ranges explicitly.
 */
export class AdaptivePolicy implements Policy {
  readonly name = "adaptive";
  readonly by = "code";

  explain(d: Discrepancy, hypotheses: Hypothesis[]) {
    const relevant = hypotheses.filter((h) => h.support.high > 0);
    const refs = new Set(d.observed.map((f) => f.ref));
    const covered = relevant.map((h) => ({
      id: h.id,
      cited: h.evidence.filter((ref) => refs.has(ref)).length,
      total: h.evidence.length,
    }));
    return {
      summary: `${d.line}: ${relevant.length} live explanation(s); ${d.observed.length} observed fact(s); evidence references ${covered.map((h) => `${h.id} ${h.cited}/${h.total}`).join(", ") || "none"}. Support ranges are unchanged until new facts arrive.`,
      hypotheses,
    };
  }

  chooseProbes(options: ProbeOption[], hypotheses: Hypothesis[], budgetMicro: number) {
    const plausible = hypotheses.filter((h) => h.support.high > 0);
    if (plausible.length < 2) {
      return { chosen: [], reason: "fewer than two live explanations; no discriminating probe justified" };
    }

    // A pair remains uncertain when the supplied ranges overlap. A probe's
    // value is how many such pairs it can distinguish, not a claimed outcome.
    const pairs = new Map<string, number>();
    for (let i = 0; i < plausible.length; i++) {
      for (let j = i + 1; j < plausible.length; j++) {
        const a = plausible[i];
        const b = plausible[j];
        if (a.support.low <= b.support.high && b.support.low <= a.support.high) {
          pairs.set(pairKey(a.id, b.id), Math.min(a.support.high, b.support.high));
        }
      }
    }

    const chosen: ProbeOption[] = [];
    const covered = new Set<string>();
    let remaining = budgetMicro;
    while (true) {
      const ranked = options
        .filter((p) => !chosen.includes(p) && p.costMicro <= remaining)
        .map((p) => {
          const ids = new Set(p.separates);
          const newlyCovered = [...pairs].filter(([key]) => {
            const [a, b] = JSON.parse(key) as [string, string];
            return !covered.has(key) && ids.has(a) && ids.has(b);
          });
          const gain = newlyCovered.reduce((sum, [, weight]) => sum + weight, 0);
          return { probe: p, newlyCovered, gain, score: gain / Math.max(1, p.costMicro) };
        })
        .filter((x) => x.gain > 0)
        .sort((a, b) => b.score - a.score || a.probe.costMicro - b.probe.costMicro || a.probe.id.localeCompare(b.probe.id));
      const best = ranked[0];
      if (!best) break;
      chosen.push(best.probe);
      remaining -= best.probe.costMicro;
      best.newlyCovered.forEach(([key]) => covered.add(key));
    }
    return {
      chosen,
      reason: chosen.length
        ? `selected ${chosen.map((p) => p.id).join(", ")} to distinguish ${covered.size} unresolved explanation pair(s); estimated probe cost ${budgetMicro - remaining} micro`
        : "no available probe distinguishes live explanations within the budget",
    };
  }

  propose(d: Discrepancy, hypotheses: Hypothesis[]): Proposal {
    const hold = (reason: string): Proposal => ({ caseId: d.caseId, action: "no_action", record: null, reason });
    const { lowMicro, highMicro } = d.interval;
    if (!Number.isSafeInteger(lowMicro) || !Number.isSafeInteger(highMicro) || lowMicro < 0 || highMicro < lowMicro) {
      return hold("invalid evidence interval; human review required");
    }
    if (lowMicro !== highMicro) return hold("evidence still supports a range; gather facts or escalate to a person");
    if (lowMicro === 0) return hold("the observed amount is zero; no settlement proposed");
    if (!d.record || d.record.caseId !== d.caseId || d.record.observed.length === 0) {
      return hold("no matching nonempty case record for independent verification");
    }
    const inputFacts = d.observed.map(canonicalJson).sort();
    const recordFacts = d.record.observed.map(canonicalJson).sort();
    if (canonicalJson(inputFacts) !== canonicalJson(recordFacts)) {
      return hold("the case record does not match the facts used for this decision");
    }
    const live = hypotheses.filter((h) => h.support.high > 0);
    if (live.length > 1) {
      const ranked = [...live].sort((a, b) => b.support.low - a.support.low);
      if (ranked[0].support.low <= ranked[1].support.high) {
        return hold("competing explanations still overlap; gather discriminating evidence or escalate");
      }
    }
    const action = d.record.kind === "pay_undisputed" ? "pay" : "refund";
    return {
      caseId: d.caseId,
      action,
      record: d.record,
      reason: "candidate only: observed facts and interval agree; independent verifier must derive the ceiling, and contract and human approval rules still govern settlement",
    };
  }
}

function pairKey(a: string, b: string): string {
  return JSON.stringify(a < b ? [a, b] : [b, a]);
}
