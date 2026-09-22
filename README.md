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

Every payment is one intent with a sequence number per case. The contract runs each number
once, so a retried payment is refused even when case-paid-so-far plus the retry would still be
under the ceiling (pay 3 of 10, retry the same 3: refused with `IntentAlreadyUsed`). A second,
deliberate partial payment takes the next number and still has to fit under the ceiling.

Deployed on Arc testnet (chain 5042002): `0xc8e1dc15F42c04EaF5Eab03C5A82C8Abc4aB01d2`.

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

## Current boundaries

- Key isolation today is the same machine, different processes. The agent and the verifier
  are separate programs reading separate key files, and the contract only accepts the
  verifier's signature. They are not yet separate system identities: a process running as the
  same OS user could read both files.
- The decision log is a hash chain. It shows any edit to an entry that is followed by later
  entries, but whoever holds the whole file can rewrite the whole chain consistently.

## After kickoff

- Real key isolation: run the verifier under its own OS user or host, with the key file
  readable only by that identity.
- Anchor the decision log: write the chain head to Arc on a fixed schedule, so a rewrite of the
  whole log no longer matches the heads already on chain.

## Starting point

This repository was started on 2026-09-23, before the Tameion window opened on 2026-09-27.
Everything here at that date is the starting point. Work and usage after it are the delta.
