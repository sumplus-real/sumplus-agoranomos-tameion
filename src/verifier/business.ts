import type { Hex } from "viem";
import { importEvidence, type EvidenceBundle } from "../evidence/import.js";
import type { TrustedReviewers } from "../evidence/review.js";
import { signCase, type SignRequest, type SignOutcome } from "./sign.js";

/** Business-facing entry point. Raw signCase is only for trusted internal records/mechanism fixtures. */
export async function signBusinessCase(bundle: EvidenceBundle, baseDir: string, trusted: TrustedReviewers, request: Omit<SignRequest, "record">, key?: Hex): Promise<SignOutcome> {
  if (bundle.status !== "business_confirmed") return { signed: false, reasons: ["business signing requires an authenticated confirmed review"] };
  const imported = importEvidence(bundle, baseDir, trusted);
  if (!imported.ok) return { signed: false, reasons: imported.errors };
  return signCase({ ...request, record: imported.record }, key);
}
