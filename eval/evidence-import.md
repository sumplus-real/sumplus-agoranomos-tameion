# Evidence intake (event period)

Keep raw exports and bundle JSON in `private-data/`; git ignores that directory. The importer checks each raw file's SHA-256, every fact's source artifact and reference, and basic amount and measurement validity. It prints only status, case ID, and counts:

```sh
npm run import:evidence -- private-data/bundle.json
```

The bundle has `status`, `artifacts`, and `record` fields. An artifact has an `id`, path relative to the bundle, `sha256`, ISO `capturedAt`, and `provenance` pointing to the relevant row or measurement method. Each observed fact's `source` must equal an artifact `id`, and `ref` identifies its source row. `record` is a `CaseRecord` from `src/evidence/case.ts`. The command also prints `factSnapshotHash`, the pre-decision SHA-256 identifier to use for all three rows of that case-day in the comparison manifest.

Use `synthetic` for invented fixtures and `self_test` for our own mechanism runs. `business_unconfirmed` requires a private `authorizationRef`; `business_confirmed` also requires a `confirmationRef` from the business user. These labels are evidence gates, not proof that the underlying source is true. A person still checks source authenticity, permission to use it, the business consequence, and what may be disclosed. No source is counted as real-business traction merely because the importer passes.

An imported record is a candidate for a policy or verifier. Importing does not sign an attestation, approve a payment, send a transaction, or imply that testnet USDC settled a real debt. Any published excerpt requires separate redaction of supplier identity, customer data, pricing, and absolute video-line amounts.

## Historical replay

Use `historical_replay` with an authorization reference for approved pre-event records.
Keep their original timestamps in `gateway_settlement.originTime`; capture time is different.
Gateway records use `settledMicro`, `requestedSeconds`, and `reportedSeconds`. They must not
be recast as `vendor_charge`. Mirrored application cost is not independent corroboration.

A private manifest contains `{"bundles":["case-1/bundle.json"]}` with relative bundle paths.
Run `npm run replay:evidence -- private-data/replay/manifest.json`. Each run preserves its
comparison input, report, and three hash-chained logs in a new directory. The latest report
is consumed by `npm run demo`. The runner reads captured ffprobe results; it does not fetch
videos, spend money, sign, or settle. The comparison rubric is unchanged; historical replay
is an additional, separate cohort. Missing human timing is null, never zero.

Duplicate-refund cases need a source-backed `duplicate_intent_assessment` with an intent ID,
original and repeated task IDs, and `confirmed_duplicate`. Identical hashes alone cannot
establish that the second generation was unintended. Unknown or conflicting intent refuses
signing. Import verifies integrity and references, not authenticity of an asserted source.
