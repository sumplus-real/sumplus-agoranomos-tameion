import { createHash } from "node:crypto";
import { canonicalJson } from "../evidence/case.js";
import { readLog, verify } from "./decision-log.js";

export type LogCheckpoint = { version: 1; logId: string; count: number; head: string; createdAt: string; commitment: string };
export function prepareCheckpoint(path: string, logId: string): LogCheckpoint {
  if (!logId.trim()) throw new Error("missing log ID");
  const entries = readLog(path);
  const checked = verify(entries);
  if (!checked.ok || !entries.length) throw new Error("cannot checkpoint an empty or invalid log");
  const body = { version: 1 as const, logId, count: entries.length, head: checked.head, createdAt: new Date().toISOString() };
  return { ...body, commitment: createHash("sha256").update(canonicalJson(body)).digest("hex") };
}
/** The caller supplies an independently retained checkpoint, not one from the log writer. */
export function verifyCheckpoint(path: string, c: LogCheckpoint): boolean {
  const { commitment, ...body } = c;
  if (c.version !== 1 || !Number.isSafeInteger(c.count) || c.count < 1 || !c.logId.trim() || !Number.isFinite(Date.parse(c.createdAt))) return false;
  if (createHash("sha256").update(canonicalJson(body)).digest("hex") !== commitment) return false;
  const entries = readLog(path);
  return verify(entries).ok && entries.length >= c.count && entries[c.count - 1].hash === c.head;
}
