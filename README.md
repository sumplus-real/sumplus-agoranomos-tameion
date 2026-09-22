# Sumplus Agoranomos

An agent that settles a business's supplier bills and customer credits against
evidence it did not write itself, inside limits it cannot change.

The business is Sumplus, which runs an AI gateway: it buys model capacity from
upstream suppliers and resells it to tenants. The agent looks at both sides.

## How money moves

Three parties, three keys:

| Party | Holds | Can |
|---|---|---|
| Owner (a person) | the owner key | set payees, budgets and the rule version; approve or reject anything above the escalation threshold |
| Verifier (a separate service) | the verifier key | sign an attestation for a case, after recomputing from observed facts the most that may be paid |
| Agent | the agent key | propose a settlement against a signed attestation, and nothing else |

`contracts/src/AgoranomosSettlement.sol` pays only when the attestation is signed by the
verifier and binds this chain, this contract, this token, one payee, a maximum amount, the
current rule version and an expiry. It records what each case has paid, counts a payee's
spending across cases so a payment cannot be split under the threshold, and treats a zero
budget as a stop.

Deployed on Arc testnet (chain 5042002): `0x8D38dbaD863f7BF2b32fC227243a5092aFad90E6`.

## Evidence

Each case keeps three layers apart: observed facts, contract readings, and inferences with a
range. Only observed facts can set the amount a case may pay. A delivered video is measured
from the file itself; a file that cannot be measured is reported as unmeasurable, never as
zero seconds.

## Running it

```bash
npm install
npm test                         # offline; the network is removed for the run
cd contracts && forge install foundry-rs/forge-std --no-git && forge test
npx tsx scripts/live-e2e.ts      # Arc testnet; needs the three key files, see below
```

Key files (`.deployer.env`, `.agent.env`, `.verifier.env`) are local and ignored by git. The
agent's code never reads the verifier's file; a test fails if it does.

## Starting point

This repository was started on 2026-09-23, before the Tameion window opened on 2026-09-27.
Everything here at that date is the starting point. Work and usage after it are the delta.
