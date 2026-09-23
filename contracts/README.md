# Contracts

`src/AgoranomosSettlement.sol` is the settlement contract described in the repository README.

```bash
forge install foundry-rs/forge-std --no-git
forge test
```

`via_ir` is on (see `foundry.toml`). Under via-IR, tests read time with
`vm.getBlockTimestamp()` rather than `block.timestamp`.

Deployed on Arc testnet (chain 5042002) at `0xc8e1dc15F42c04EaF5Eab03C5A82C8Abc4aB01d2`.
