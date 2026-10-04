#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { factSnapshotHash, importEvidence, type EvidenceBundle } from "../src/evidence/import.js";

const file = process.argv[2];
if (!file) throw new Error("usage: tsx scripts/import-evidence.ts private-data/bundle.json");
const path = resolve(file);
const bundle = JSON.parse(readFileSync(path, "utf8")) as EvidenceBundle;
const trustFile = process.argv[3];
const result = importEvidence(bundle, dirname(path), trustFile ? JSON.parse(readFileSync(trustFile, "utf8")) : {});
if (!result.ok) {
  for (const error of result.errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: result.status, caseId: result.record.caseId, factSnapshotHash: factSnapshotHash(result.record), factCount: result.record.observed.length, artifactCount: bundle.artifacts.length }));
}
