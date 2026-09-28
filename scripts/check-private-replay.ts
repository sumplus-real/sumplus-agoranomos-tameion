import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(process.argv[2] ?? 'private-data/historical-replay-20260928');
const sources = readdirSync(root).filter(n => n.endsWith('.saferouter.json'));
assert.equal(sources.length, 3, 'expected approved source count');
const forbidden: string[] = [];
for (const file of sources) {
  const o = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
  for (const field of ['id', 'upstream_task_id', 'provider', 'model', 'request_sha256', 'settled_usd']) {
    assert(o[field] !== undefined); forbidden.push(String(o[field]));
  }
  const m = JSON.parse(readFileSync(resolve(root, `${o.id}.delivery-measurement.json`), 'utf8'));
  forbidden.push(m.job_id, m.url_sha256, m.source);
}
const response = await fetch('http://127.0.0.1:4173/api/report');
assert.equal(response.status, 200);
const body = await response.text(), data = JSON.parse(body);
assert.equal(data.mode, 'historical_replay'); assert.equal(data.report.cases.length, 3);
assert.equal(data.report.score.rowCount, 9);
assert(data.report.score.cohorts.every((c: any) => c.caseClass === 'historical_replay'));
const leaks = (s: string) => forbidden.some(v => s.includes(v));
assert(!leaks(body), 'private source field leaked into UI response');
assert(leaks(body + forbidden[0]), 'redaction known-positive control failed');
assert(!/settledMicro|chargedMicro|debitedMicro/.test(body));
assert(data.report.strategies.every((s: any) => s.passed === 0));
console.log('Private replay API: 3 cases / 9 results, historical cohort, refusals, redaction and positive control passed');
