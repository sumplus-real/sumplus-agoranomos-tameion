#!/usr/bin/env tsx
import { writeFileSync } from "node:fs";
import { prepareCheckpoint } from "../src/loop/checkpoint.js";
const [log, id, output] = process.argv.slice(2);
if (!output) throw new Error("usage: checkpoint-log log.jsonl log-id checkpoint.json");
writeFileSync(output, JSON.stringify(prepareCheckpoint(log, id), null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log("Checkpoint prepared locally; external anchoring has not occurred.");
