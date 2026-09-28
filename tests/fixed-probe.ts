import assert from "node:assert/strict";
import { FixedProbePolicy } from "../src/loop/fixed-probe.js";

const policy = new FixedProbePolicy();
const options = [
  { id: "a", line: "video", description: "first", costMicro: 7, separates: [] },
  { id: "b", line: "video", description: "second", costMicro: 1, separates: [] },
  { id: "c", line: "text", description: "first", costMicro: 3, separates: [] },
];
assert.deepEqual(policy.chooseProbes(options, [], 10).chosen.map((x) => x.id), ["a", "c"]);
assert.deepEqual(policy.chooseProbes(options, [], 4).chosen.map((x) => x.id), ["b", "c"]);
assert.equal(policy.chooseProbes(options, [], 0).chosen.length, 0);
console.log("fixed-probe policy: 3 checks passed");
