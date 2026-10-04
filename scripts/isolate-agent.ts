#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** macOS local preparation only. Root can override it; this is not separate-user custody. */
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("usage: isolate-agent command args...");
if (process.platform !== "darwin") throw new Error("this wrapper requires macOS sandbox-exec; no silent unisolated fallback");
const root = fileURLToPath(new URL("../", import.meta.url));
const protectedPaths = [resolve(root, ".verifier.env"), resolve(root, ".deployer.env"), resolve(root, "private-data/reviewer-keys"), resolve(root, "private-data/trusted-reviewers.json"), process.env.VERIFIER_ENV_FILE, process.env.OWNER_ENV_FILE, process.env.TRUSTED_REVIEWERS_FILE].filter((p): p is string => !!p).flatMap(p => {
  const path = resolve(p);
  try { return [path, realpathSync(path)]; } catch { return [path]; }
});
const profile = `(version 1) (allow default) (deny file-read* file-write* ${protectedPaths.map(p => `(subpath ${JSON.stringify(p)})`).join(" ")})`;
const env = { ...process.env };
for (const name of ["VERIFIER_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "OWNER_PRIVATE_KEY"]) delete env[name];
const child = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, command, ...args], { stdio: "inherit", env });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
