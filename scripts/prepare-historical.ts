import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, basename } from 'node:path';
import { caseIdFor } from '../src/evidence/case.js';
const root = resolve(process.argv[2] ?? 'private-data/historical-replay-20260928');
const capture = JSON.parse(readFileSync(resolve(root, 'capture-manifest.json'), 'utf8'));
const inputs = readdirSync(root).filter(p => p.endsWith('.saferouter.json')).sort();
if (inputs.length !== 3) throw new Error('expected three approved historical source records');
const bundles: string[] = [];
for (const name of inputs) {
  const raw = JSON.parse(readFileSync(resolve(root, name), 'utf8'));
  const measurementName = `${raw.id}.delivery-measurement.json`;
  const measurement = JSON.parse(readFileSync(resolve(root, measurementName), 'utf8'));
  if (measurement.provider_task_id !== raw.id || raw.state !== 'succeeded') throw new Error('source linkage or state mismatch');
  const originTime = new Date(raw.created_at_ms).toISOString();
  if (originTime >= '2026-09-27T00:00:00Z') throw new Error('source is outside the pre-event replay cohort');
  const measuredSeconds = Number(measurement.ffprobe_output.format.duration);
  if (!Number.isFinite(measuredSeconds) || measuredSeconds <= 0 || !Number.isFinite(raw.settled_usd) || raw.settled_usd < 0) throw new Error('invalid observed amounts or duration');
  const artifact = (path: string, id: string, capturedAt: string, provenance: string) => ({ id, path,
    sha256: createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'), capturedAt, provenance });
  const bundle = { status: 'historical_replay', authorizationRef: 'User-approved private historical replay, delegated 2026-09-28',
    artifacts: [artifact(name, 'gateway', capture.captured_at, `read-only source projection; command ${capture.command_id}; row ${raw.id}`),
      artifact(measurementName, 'measurement', measurement.captured_at, `captured ffprobe format duration from retained delivery; join ${measurement.provider_task_id}`),
      artifact('capture-manifest.json', 'capture', capture.captured_at, 'read-only export provenance')],
    record: { caseId: caseIdFor(['historical-replay', raw.id]), kind: 'pay_undisputed', counterparty: 'supplier-A',
      observed: [{ kind: 'gateway_settlement', source: 'gateway', ref: raw.id, jobRef: raw.id,
        requestedSeconds: raw.requested_seconds, reportedSeconds: raw.duration_secs,
        settledMicro: Math.ceil(raw.settled_usd * 1e6), originTime },
        { kind: 'delivery_measured', source: 'measurement', ref: `${raw.id}:format.duration`, jobRef: raw.id, measuredSeconds }],
      contract: [], inference: [{ claim: 'Gateway cost is not supplier invoice evidence', lowMicro: 0, highMicro: Math.ceil(raw.settled_usd * 1e6),
        basis: 'Original amount retained in source file; rounded upward to micro units only for unresolved interval, never a payable amount. ffprobe measures container duration, including audio.' }] } };
  const output = `${raw.id}.bundle.json`;
  writeFileSync(resolve(root, output), JSON.stringify(bundle, null, 2)); bundles.push(output);
}
writeFileSync(resolve(root, 'manifest.json'), JSON.stringify({ bundles }, null, 2));
console.log(JSON.stringify({ bundles: bundles.length, directory: basename(root) }));
