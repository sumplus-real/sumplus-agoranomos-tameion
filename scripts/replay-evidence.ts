import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importEvidence, factSnapshotHash, type EvidenceBundle } from '../src/evidence/import.js';
import { FixedPolicy, runDay, type Hypothesis } from '../src/loop/day.js';
import { FixedProbePolicy } from '../src/loop/fixed-probe.js';
import { AdaptivePolicy } from '../src/loop/adaptive.js';
import { judge } from '../src/verifier/rules.js';
import { readLog, verify } from '../src/loop/decision-log.js';
import { scoreComparison } from './score-comparison.js';

/** Replay existing captured artifacts only. No network, signing, or settlement. */
export function replayEvidence(bundlePaths: string[], outputRoot: string) {
  if (!bundlePaths.length) throw new Error('at least one private bundle is required');
  const bundles = bundlePaths.map(file => {
    const bundle = JSON.parse(readFileSync(file, 'utf8')) as EvidenceBundle;
    const imported = importEvidence(bundle, dirname(file));
    if (!imported.ok) throw new Error(imported.errors.join('; '));
    if (bundle.status !== 'historical_replay') throw new Error('replay requires historical_replay status');
    return bundle;
  });
  if (new Set(bundles.map(b => b.record.caseId)).size !== bundles.length) throw new Error('duplicate case IDs');
  mkdirSync(outputRoot, { recursive: true });
  const runDir = mkdtempSync(join(outputRoot, 'run-'));
  const generatedAt = new Date().toISOString(), day = generatedAt.slice(0, 10);
  const rows: any[] = [], caseDays: any[] = [], cases: any[] = [];
  const strategies = [new FixedPolicy(), new FixedProbePolicy(), new AdaptivePolicy()].map(policy => ({
    id: policy.name, label: policy.name, attempts: 0, passed: 0, totalCost: 0,
    decisions: [] as any[], policy,
  }));
  for (const bundle of bundles) {
    const record = bundle.record;
    const measurements = record.observed.filter(f => f.kind === 'delivery_measured');
    const gateway = record.observed.find(f => f.kind === 'gateway_settlement');
    if (!gateway || !measurements.length) throw new Error('historical video replay needs gateway settlement and captured measurement');
    const initial = { ...record, observed: record.observed.filter(f => f.kind !== 'delivery_measured') };
    const snapshot = factSnapshotHash(initial);
    caseDays.push({ day, caseId: record.caseId, caseClass: 'historical_replay', factSnapshotHash: snapshot, sourceRefs: bundle.artifacts.map(a => a.id) });
    cases.push({ id: record.caseId, label: `Historical clip ${cases.length + 1}`, requestedSeconds: gateway.requestedSeconds, measuredSeconds: measurements[0].measuredSeconds, sourceDate: gateway.originTime, evidenceStatus: 'historical_replay' });
    for (const strategy of strategies) {
      const line = record.caseId;
      const hypotheses: Hypothesis[] = ['adequate_delivery', 'short_delivery'].map(id => ({ id, statement: id, support: { low: 0, high: 1 }, evidence: [] }));
      const result = runDay({ day, logPath: join(runDir, `${strategy.id}.jsonl`), policy: strategy.policy,
        discrepancies: [{ line, caseId: record.caseId, observed: initial.observed, record: initial,
          interval: { lowMicro: 0, highMicro: gateway.settledMicro, claim: 'Unverified payable amount', basis: 'Gateway settlement is not an independent supplier invoice' } }],
        hypotheses, probeBudgetMicro: 0,
        probeOptions: [{ id: `measurement-${record.caseId}`, line, description: 'Read captured ffprobe evidence; no new measurement or paid call', costMicro: 0, separates: hypotheses.map(h => h.id) }],
        executeProbe: () => ({ status: 'observed', caseId: record.caseId, addedFacts: measurements, record,
          actualCostMicro: 0, reason: 'Replay captured duration; missing supplier invoice remains unresolved' }),
      });
      const observedRecord = result.observedRecords[0];
      const verdict = observedRecord ? judge(observedRecord, { [record.counterparty]: '0x0000000000000000000000000000000000000001' }) : { sign: false as const, reasons: ['No complete record observed on this policy path'] };
      const proposal = result.proposals[0];
      // A candidate recommendation is not a resolved business case.
      const resolved = proposal.action !== 'no_action' && verdict.sign;
      strategy.attempts++; strategy.passed += Number(verdict.sign);
      strategy.totalCost += result.probeSpentMicro ?? 0;
      strategy.decisions.push({ caseId: record.caseId, action: proposal.action, reason: proposal.reason,
        verifierSign: verdict.sign, verifierReasons: verdict.sign ? verdict.basis : verdict.reasons });
      rows.push({ day, caseId: record.caseId, policy: strategy.id, factSnapshotHash: snapshot,
        evidenceRefs: bundle.artifacts.map(a => a.id), probeCount: result.probesExecuted,
        probeCostMicro: result.probeSpentMicro, outcome: resolved ? 'resolved' : 'escalated', adjudication: 'pending', humanSeconds: null });
    }
  }
  const comparison = { caseDays, rows }, score = scoreComparison(comparison);
  const logs = strategies.map(s => ({ policy: s.id, ...verify(readLog(join(runDir, `${s.id}.jsonl`))) }));
  if (logs.some(l => !l.ok)) throw new Error('decision log verification failed');
  const report = { schemaVersion: 1, generatedAt, datasetLabel: '赛前数据回放 / Historical replay',
    disclosure: ['Private historical evidence, not event-period adoption.', 'Gateway settlement and mirrored cost share one origin; neither is an independent supplier invoice.', 'Captured ffprobe container duration (including audio) is replayed, not newly measured by this run.', 'Deterministic adaptive code, not an LLM. No signing or settlement occurs.', 'External replay spend is zero; CPU time is unmetered. Human review time and adjudication remain unknown.'],
    cases, strategies: strategies.map(({ policy, ...rest }) => rest), score, logs };
  writeFileSync(join(runDir, 'comparison.json'), JSON.stringify(comparison, null, 2));
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(outputRoot, 'report.json'), JSON.stringify(report, null, 2));
  return { runDir, report };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const manifestPath = resolve(process.argv[2] ?? 'private-data/replay/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.bundles) || manifest.bundles.some((v: unknown) => typeof v !== 'string')) throw new Error('manifest.bundles must be paths');
  const result = replayEvidence(manifest.bundles.map((p: string) => resolve(dirname(manifestPath), p)), resolve('private-data/replay'));
  console.log(JSON.stringify({ runDir: result.runDir, cases: result.report.cases.length, score: result.report.score }));
}
