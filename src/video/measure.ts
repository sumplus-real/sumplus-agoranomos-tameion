import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { DURATION_TOLERANCE_SECONDS } from "../verifier/rules.js";

/**
 * Measuring a delivered clip ourselves.
 *
 * A video line bills by the second, and the delivered file carries its own
 * length. ffprobe reads it from the container and the streams, which no
 * party to the bill wrote. That makes it a fact in the observed layer.
 *
 * It measures the file, and only the file. Whether the contract bills by the
 * seconds requested, the seconds delivered, a rounded-up second, or per
 * attempt is a contract question, and it is answered elsewhere.
 */

const run = promisify(execFile);

export type Measurement =
  | { status: "measured"; seconds: number; streams: number }
  | { status: "unmeasurable"; reason: string };

/**
 * Three answers, never two. A file that is missing or unreadable is not a
 * zero-second clip; reporting it as zero would turn "we could not look" into
 * "they delivered nothing", which is an accusation the evidence does not make.
 */
export async function measure(path: string): Promise<Measurement> {
  try {
    await access(path);
  } catch {
    return { status: "unmeasurable", reason: "the file is not there" };
  }

  let stdout: string;
  try {
    ({ stdout } = await run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,duration",
      "-of", "json",
      path,
    ]));
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { status: "unmeasurable", reason: `ffprobe could not read it: ${message.slice(0, 160)}` };
  }

  let parsed: { format?: { duration?: string }; streams?: { codec_type?: string; duration?: string }[] };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { status: "unmeasurable", reason: "ffprobe returned something that is not JSON" };
  }

  const video = (parsed.streams ?? []).filter((s) => s.codec_type === "video");
  if (video.length === 0) return { status: "unmeasurable", reason: "the file has no video stream" };

  // The video stream's own duration first; the container's if the stream
  // does not state one. Both come from the file itself.
  const streamSeconds = Number(video[0].duration);
  const formatSeconds = Number(parsed.format?.duration);
  const seconds = Number.isFinite(streamSeconds) && streamSeconds > 0 ? streamSeconds : formatSeconds;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { status: "unmeasurable", reason: "the file states no usable duration" };
  }

  return { status: "measured", seconds: Math.round(seconds * 1000) / 1000, streams: video.length };
}

export type Comparison =
  | { outcome: "consistent"; billedSeconds: number; measuredSeconds: number }
  | { outcome: "short"; billedSeconds: number; measuredSeconds: number; shortBySeconds: number }
  | { outcome: "unmeasurable"; billedSeconds: number; reason: string };

/** Billed seconds against what arrived, within the encoder's rounding. */
export function compare(billedSeconds: number, m: Measurement): Comparison {
  if (m.status === "unmeasurable") return { outcome: "unmeasurable", billedSeconds, reason: m.reason };
  if (m.seconds + DURATION_TOLERANCE_SECONDS >= billedSeconds) {
    return { outcome: "consistent", billedSeconds, measuredSeconds: m.seconds };
  }
  return {
    outcome: "short",
    billedSeconds,
    measuredSeconds: m.seconds,
    shortBySeconds: Math.round((billedSeconds - m.seconds) * 1000) / 1000,
  };
}
