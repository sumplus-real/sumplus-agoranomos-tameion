# Prospective comparison criteria · fixed on 2026-09-27

Compare three policies on the same real cases on the same day: `fixed`,
`fixed_probe`, and `adaptive`. Only `adaptive` may submit a transaction. The
other policies are counterfactual decisions, not claims that their proposed
payments happened.

The unit of analysis is one `(day, caseId, policy)` decision. Include every
case opened during the study window, including cases held, escalated, or later
found wrong. A case-day is scored only when all three policies have a row.
Missing rows fail the scorer instead of shrinking a denominator silently.

Each input row must carry:

- `day` (ISO date), `caseId`, `policy`, and `evidenceRefs` linking to the
  decision log, source measurements, and any human review;
- `probeCount` and `probeCostMicro`, both nonnegative integers. Cost is the
  actual amount charged for evidence collection in micro-USDC, excluding
  settlement principal and chain gas. Free probes count as probes with zero
  cost;
- `outcome`: `resolved` or `escalated`. A held or unknown case is escalated,
  even if a person has not yet answered;
- `adjudication`: `upheld`, `overturned`, or `pending`. Review compares the
  policy's conclusion with a later human decision or new independent evidence.
  An escalation has no conclusion to overturn and must be `pending`;
- `humanSeconds`: actual active review time, including investigation and
  approval, or `null` if it was not measured. Do not replace missing time with
  zero.

Report, for each policy:

1. **Evidence cost**: total `probeCostMicro` and total `probeCount`, each also
   divided by the full number of case-days.
2. **Overturned conclusion rate**: count of `overturned` divided by the number
   of `resolved` rows with `upheld` or `overturned` adjudication. Always print
   the numerator, denominator, and count still pending. An escalation is not a
   false alarm.
3. **Autonomous resolution share**: `resolved` rows divided by all case-day
   rows. This measures decisions, not successful payments.
4. **Human time**: sum of measured `humanSeconds`, number of rows with measured
   time, and number missing. If any are missing, the sum is an observed lower
   bound, not a complete total.

The three policies get identical input facts available at the decision time.
Later facts may adjudicate a conclusion but must not be fed back into the
earlier decision. Report case counts and missing adjudications beside any
comparison. No metric is a success claim until activity-period data exist.

Run `npm run score:comparison -- path/to/rows.json` on a JSON array of rows.
