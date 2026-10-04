#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { importEvidence, type EvidenceBundle } from "../src/evidence/import.js";
import { reviewPayload, type BusinessReview, type TrustedReviewers } from "../src/evidence/review.js";
import { append, readLog, verify } from "../src/loop/decision-log.js";

const [bundleFile, reviewFile, trustFile, outputFile] = process.argv.slice(2);
if (!outputFile) throw new Error("usage: review-evidence bundle.json signed-review.json owner-trusted-reviewers.json output.json");
const path = resolve(bundleFile);
const bundle = JSON.parse(readFileSync(path, "utf8")) as EvidenceBundle;
const review = JSON.parse(readFileSync(reviewFile, "utf8")) as BusinessReview;
const trust = JSON.parse(readFileSync(trustFile, "utf8")) as TrustedReviewers;
if (bundle.status !== "business_unconfirmed") throw new Error("only unconfirmed business evidence may enter this workflow");
if (resolve(outputFile) === path || dirname(resolve(outputFile)) !== dirname(path)) throw new Error("preserve original bundle; write a new file beside it");
const reviewed: EvidenceBundle = { ...bundle, review, status: review.outcome === "confirmed" ? "business_confirmed" : "business_unconfirmed", confirmationRef: review.sourceRef };
const result = importEvidence(reviewed, dirname(path), trust);
if (!result.ok) throw new Error(result.errors.join("; "));
const logPath = resolve(dirname(path), "human-reviews.jsonl");
const log = readLog(logPath);
if (!verify(log).ok) throw new Error("existing human review log is invalid");
const reviewHash = createHash("sha256").update(reviewPayload(review) + review.signature).digest("hex");
if (log.some(e => e.detail.reviewHash === reviewHash)) throw new Error("this business review has already been recorded");
writeFileSync(resolve(outputFile), JSON.stringify(reviewed, null, 2) + "\n", { flag: "wx", mode: 0o600 });
append(logPath, { day: review.reviewedAt.slice(0, 10), caseId: result.record.caseId, kind: "reviewed", by: "person", summary: `Business review ${review.outcome}`, detail: { reviewHash, bundleHash: review.bundleHash, reviewerId: review.reviewerId, outcome: review.outcome, sourceRef: review.sourceRef, humanSeconds: review.humanSeconds }, at: review.reviewedAt });
console.log(JSON.stringify({ caseId: result.record.caseId, status: result.status, outcome: review.outcome, humanSeconds: review.humanSeconds, paymentAuthorized: false }));
