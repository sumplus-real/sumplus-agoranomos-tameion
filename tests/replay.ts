import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { caseIdFor } from '../src/evidence/case.js';
import { replayEvidence } from '../scripts/replay-evidence.js';
const root = mkdtempSync(join(tmpdir(), 'agoranomos-replay-test-'));
try {
  // Invented fixture only. Its historical label exercises the intake gate; it is not business evidence.
  const bytes = JSON.stringify({ fixture: true, seconds: 6.08 });
  writeFileSync(join(root, 'source.json'), bytes);
  const bundle = { status: 'historical_replay', authorizationRef: 'synthetic regression fixture',
    artifacts: [{ id: 'fixture', path: 'source.json', sha256: createHash('sha256').update(bytes).digest('hex'), capturedAt: '2026-09-28T00:00:00Z', provenance: 'invented unit fixture' }],
    record: { caseId: caseIdFor(['replay-fixture']), kind: 'pay_undisputed', counterparty: 'fixture', contract: [], inference: [], observed: [
      { kind: 'gateway_settlement', source: 'fixture', ref: 'gateway', jobRef: 'job', requestedSeconds: 6, reportedSeconds: 6, settledMicro: 123, originTime: '2026-09-08T00:00:00Z' },
      { kind: 'delivery_measured', source: 'fixture', ref: 'ffprobe', jobRef: 'job', measuredSeconds: 6.08 },
    ] } };
  const path = join(root, 'bundle.json');
  writeFileSync(path, JSON.stringify(bundle));
  const { report } = replayEvidence([path], join(root, 'output'));
  assert.equal(report.score.rowCount, 3);
  assert.equal(report.score.cohorts[0].caseClass, 'historical_replay');
  assert.deepEqual(report.strategies.map(s => s.passed), [0, 0, 0]);
  assert.deepEqual(report.score.cohorts[0].policies.map(s => s.evidence.probeCount), [0, 1, 1]);
  assert(report.logs.every(l => l.ok));
  assert(report.score.cohorts[0].policies.every(p => p.autonomousResolution.resolved === 0 && p.humanTime.missingRows === 1));
  // Positive invoice fixture exposes look-ahead: fixed has not read the delivery.
  const positive = structuredClone(bundle);
  (positive.record.observed as any[]).push({ kind: 'vendor_charge', source: 'fixture', ref: 'independent-invoice', jobRef: 'job', billedSeconds: 6, chargedMicro: 123 });
  writeFileSync(path, JSON.stringify(positive));
  const positiveReport = replayEvidence([path], join(root, 'positive')).report;
  assert.deepEqual(positiveReport.strategies.map(s => s.passed), [0, 1, 1], 'fixed must not see future probe facts');
  assert.equal(positiveReport.strategies[0].decisions[0].verifierSign, false);
  assert.throws(() => replayEvidence([path,path], join(root, 'bad')), /duplicate case/);
  writeFileSync(join(root, 'source.json'), 'tampered');
  assert.throws(() => replayEvidence([path], join(root, 'bad')), /hash changed/);
  console.log('replay: three-policy chain, refusal, historical cohort, and tamper controls passed');
} finally { rmSync(root, { recursive: true, force: true }); }
