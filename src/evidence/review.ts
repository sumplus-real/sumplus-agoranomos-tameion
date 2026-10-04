import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "./case.js";
import type { EvidenceBundle } from "./import.js";

export type BusinessReview = {
  version: 1;
  bundleHash: string;
  reviewerId: string;
  outcome: "confirmed" | "rejected";
  reviewedAt: string;
  sourceRef: string;
  reason: string;
  humanSeconds: number;
  signature: string;
};
/** Provisioned by the owner, outside the submitted bundle. Never trust a key supplied by an agent. */
export type TrustedReviewers = Record<string, { publicKeyPem: string; counterparty: string }>;

export function reviewBundleHash(bundle: EvidenceBundle): string {
  const { review: _review, status: _status, confirmationRef: _ref, ...content } = bundle;
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}
export function reviewPayload(review: BusinessReview): string {
  const { signature: _signature, ...body } = review;
  return canonicalJson(body);
}
export function verifyBusinessReview(bundle: EvidenceBundle, trusted: TrustedReviewers): string[] {
  const r = bundle.review;
  if (!r) return ["missing authenticated business review"];
  const errors: string[] = [];
  const signer = trusted[r.reviewerId];
  if (r.version !== 1 || !["confirmed", "rejected"].includes(r.outcome)) errors.push("invalid review version or outcome");
  if (r.bundleHash !== reviewBundleHash(bundle)) errors.push("review does not bind current bundle");
  if (!r.sourceRef?.trim() || !r.reason?.trim()) errors.push("review requires source reference and reason");
  if (bundle.status === "business_confirmed" && bundle.confirmationRef !== r.sourceRef) errors.push("confirmation reference must match the authenticated review");
  const reviewed = Date.parse(r.reviewedAt);
  if (!Number.isFinite(reviewed) || reviewed > Date.now()) errors.push("invalid review time");
  if (!Number.isFinite(r.humanSeconds) || r.humanSeconds < 0) errors.push("invalid human review time");
  if (!signer || signer.counterparty !== bundle.record.counterparty) errors.push("reviewer is not authorized for this counterparty");
  else {
    try {
      const key = createPublicKey(signer.publicKeyPem);
      if (key.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(reviewPayload(r)), key, Buffer.from(r.signature, "base64"))) errors.push("invalid business review signature");
    } catch { errors.push("invalid business review signature"); }
  }
  if (r.outcome === "rejected" && bundle.status === "business_confirmed") errors.push("rejected business review cannot become confirmed use");
  return errors;
}
