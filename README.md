# Sumplus Agoranomos

An AI agent that settles a business's supplier bills and customer credits in USDC on Arc,
paying only what an independent verifier has signed for, inside limits the agent cannot change.

Built for the Tameion Agents Hackathon (Canteen × Circle).

## The problem

Sumplus runs an AI gateway. It buys model and video capacity from upstream suppliers and
resells it to tenants. Both sides of that business produce bills that do not match reality:

- an upstream supplier charges twice for one request that was retried;
- a video job is billed for more seconds than the file that came back actually contains;
- a tenant is debited for a job that failed.

Someone has to check each bill against what actually happened, decide what is owed, and pay
or refund it. Today that is a person with spreadsheets. An agent can do the checking, but
nobody should let a language model move money on its own say-so.

## How it works

Three parties, three keys:

| Party | Holds | Can |
|---|---|---|
| Owner (a person) | the owner key | allowlist payees; set budgets and the rule version; approve or reject anything above the escalation threshold |
| Verifier (a separate process) | the verifier key | recompute, from observed facts only, the most a case may pay, and sign an attestation for it |
| Agent | the agent key | choose whether, when and how much to settle against a signed attestation, and nothing else |

The agent decides; the verifier caps; the contract enforces. The settlement contract
(`contracts/src/AgoranomosSettlement.sol`) pays only when:

1. the attestation is EIP-712 signed by the verifier and binds this chain, this contract, the
   USDC token, one payee, a maximum amount, the current rule version and an expiry;
2. the case's total paid stays under that maximum;
3. the payment carries the case's next intent number. Each intent runs once, so a retried
   payment is refused even when it would still fit under the ceiling;
4. the payee's spending this period, counted across all cases, stays under the escalation
   threshold. Above it the payment is held until the owner approves or rejects it;
5. the global period budget is not exhausted. A zero budget means stop, never "no limit".

### Evidence

Each case keeps three layers apart:

| Layer | Contents | Can it set the amount? |
|---|---|---|
| Observed facts | order ids, charges, measured delivery, failure records | yes. The verifier computes the ceiling from this layer only |
| Contract readings | which term applies and how it reads | no. Disagreeing readings are listed with the amount under each |
| Inferences | estimates with a range | never raises an amount. It can only send a case to a person |

A delivered video is measured from the file itself with ffprobe. A file that cannot be
measured is reported as unmeasurable, never as zero seconds.

### Decision log

Every step of the daily loop is appended to a hash-chained log that records who took it:
code, model, verifier, contract or person.

## Live on Arc testnet

| What | Where |
|---|---|
| Settlement contract | [`0xc8e1dc15F42c04EaF5Eab03C5A82C8Abc4aB01d2`](https://explorer.testnet.arc.io/address/0xc8e1dc15F42c04EaF5Eab03C5A82C8Abc4aB01d2) (chain 5042002) |
| Deployment | [`0x58eccd7e…`](https://explorer.testnet.arc.io/tx/0x58eccd7ef6cc5567b61684acd055ac733170256426c2aa538b8a70bc53c578d6) |
| A partial settlement, submitted by the agent | [`0x379786b1…`](https://explorer.testnet.arc.io/tx/0x379786b1f7ae0b70e148ba422632cff2630516785f59ec36ce24a4eadcccf19c) |
| Verifier | `0xD65b82a7492fa7B821D19Aa6AeFE4C891A7E683e` |
| Agent | `0x98c814A375e6671AF4B7539d3923f2c8C6d56E46` |
| Owner | `0xEcbf85c358F5318D19DefbF0643f1D86f20E6820` |

The mechanism test (`scripts/live-e2e.ts`) runs against this contract and checks that each
attack is refused for the expected reason:

| Attempt | Result |
|---|---|
| the agent signs its own attestation | `ForgedAttestation` |
| a real signature pointed at a different allowlisted payee | `ForgedAttestation` |
| more than the verifier's ceiling | `ExceedsAttestedMaximum` |
| a partial payment of 0.2 against a ceiling of 0.5 | paid |
| the same intent retried for 0.2, still under the ceiling | `IntentAlreadyUsed` |
| control: the same 0.2 under a new intent number | allowed in simulation |
| a new intent asking past the ceiling | `ExceedsAttestedMaximum` |

## Running it

Requirements: Node 20+, Foundry, ffprobe (only for the video measurer).

```bash
npm install
npm run typecheck
npm test                          # offline, 44 checks; the network is removed for the run

cd contracts
forge install foundry-rs/forge-std --no-git
forge test                        # 27 tests, including the attack and control cases
```

The live mechanism test needs three local key files (`.deployer.env`, `.agent.env`,
`.verifier.env`, each holding one `*_PRIVATE_KEY=` line) funded with Arc testnet USDC:

```bash
npx tsx scripts/live-e2e.ts
```

Key files are ignored by git. The agent's code never reads the verifier's key file, and a test
fails if it does.

## Layout

```
contracts/src/AgoranomosSettlement.sol   settlement contract
contracts/test/                          Foundry tests: limits, attacks, controls
src/verifier/                            rules (v1) and signing, separate from the agent
src/agent/submit.ts                      the agent's only way to move money
src/evidence/case.ts                     case records and the evidence hash
src/video/measure.ts                     ffprobe measurement; unmeasurable is its own result
src/loop/                                daily loop and hash-chained decision log
scripts/live-e2e.ts                      mechanism test on Arc testnet
tests/run.ts                             offline checks
```

## Where the event starts

This repository was started on 2026-09-23, before the Tameion window opened on 2026-09-27.
Everything above existed at that date and is the baseline. The tag `tameion-start` marks it;
work and usage after the tag are what we submit for judging, and the comparison
`tameion-start...main` shows only that work.

## Current boundaries

- Key isolation is the same machine, different processes. The agent and verifier are separate
  programs reading separate key files, and the contract only accepts the verifier's signature.
  They are not yet separate system identities: a process running as the same OS user could read
  both files.
- The decision log is a hash chain. It shows an edit to any entry that later entries depend on,
  but whoever holds the whole file can rewrite the whole chain consistently.
- Circle Wallets spending policies apply on mainnet only, so every limit here is enforced by the
  contract.
- All settlement is in Arc testnet USDC. It discharges no real debt.

## During the event

- Run the daily loop on real bills, with three strategies side by side on the same cases (fixed
  check, fixed probe, adaptive) against comparison criteria committed at kickoff.
- Real key isolation: the verifier under its own OS identity.
- Anchor the decision log: write its chain head to Arc on a fixed schedule.

## License

MIT
