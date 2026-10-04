import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonicalJson } from "../evidence/case.js";

/**
 * The agent's decision record: append-only, one JSON object per line, each
 * entry committing to its own content and to the hash of the entry before it.
 *
 * Verifying it recomputes every hash from the content and carries the
 * recomputed hash forward, never the stored one. Carrying the stored hash
 * would stop an edit from reaching the next entry, and a chain where
 * tampering does not propagate is only a list.
 */

export const GENESIS = "0".repeat(64);

export type DecisionEntry = {
  seq: number;
  at: string;
  day: string;
  caseId: string | null;
  /** What happened: a measurement, an explanation, a probe chosen, a verdict revised, an action proposed. */
  kind: "measured" | "explained" | "probe_chosen" | "probe_skipped" | "probe_result" | "probe_failed" | "revised" | "proposed" | "escalated" | "executed" | "reviewed";
  /** Who did it: deterministic code, the reasoning model, the verifier, the contract, or a person. */
  by: "code" | "model" | "verifier" | "contract" | "person";
  summary: string;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function hashOf(e: Omit<DecisionEntry, "hash">): string {
  return sha256(canonicalJson(e));
}

export function readLog(path: string): DecisionEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as DecisionEntry);
}

export function append(
  path: string,
  entry: Omit<DecisionEntry, "seq" | "prevHash" | "hash" | "at"> & { at?: string },
): DecisionEntry {
  const log = readLog(path);
  const prev = log[log.length - 1];
  const body: Omit<DecisionEntry, "hash"> = {
    seq: log.length,
    at: entry.at ?? new Date().toISOString(),
    day: entry.day,
    caseId: entry.caseId,
    kind: entry.kind,
    by: entry.by,
    summary: entry.summary,
    detail: entry.detail,
    prevHash: prev ? prev.hash : GENESIS,
  };
  const full: DecisionEntry = { ...body, hash: hashOf(body) };
  appendFileSync(path, `${JSON.stringify(full)}\n`, { mode: 0o600 });
  return full;
}

export type Problem = { seq: number; kind: "hash_mismatch" | "broken_link" | "bad_sequence"; detail: string };

export function verify(entries: DecisionEntry[]): { ok: boolean; head: string; problems: Problem[] } {
  const problems: Problem[] = [];
  let expectedPrev = GENESIS;
  entries.forEach((e, i) => {
    if (e.seq !== i) problems.push({ seq: e.seq, kind: "bad_sequence", detail: `numbered ${e.seq} at position ${i}` });
    if (e.prevHash !== expectedPrev) {
      problems.push({ seq: e.seq, kind: "broken_link", detail: `points at ${e.prevHash.slice(0, 10)}, the entry before hashes to ${expectedPrev.slice(0, 10)}` });
    }
    const { hash, ...body } = e;
    const recomputed = hashOf(body);
    if (recomputed !== hash) {
      problems.push({ seq: e.seq, kind: "hash_mismatch", detail: `content hashes to ${recomputed.slice(0, 10)}, entry claims ${hash.slice(0, 10)}` });
    }
    expectedPrev = recomputed;
  });
  return { ok: problems.length === 0, head: entries.length ? entries[entries.length - 1].hash : GENESIS, problems };
}
