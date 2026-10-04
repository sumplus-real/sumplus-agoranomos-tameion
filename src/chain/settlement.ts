import type { Address, Hex } from "viem";

/**
 * The on-chain side, described once. The verifier signs against these types
 * and the agent submits against this ABI, so the two cannot drift into
 * disagreeing about what an attestation is.
 */

export const ARC_TESTNET = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
} as const;

/** Native USDC on Arc also answers the ERC-20 interface, at 6 decimals. */
export const ARC_USDC: Address = "0x3600000000000000000000000000000000000000";

export const SETTLEMENT_ADDRESS: Address = (process.env.SETTLEMENT_ADDRESS ??
  "0xc8e1dc15F42c04EaF5Eab03C5A82C8Abc4aB01d2") as Address;

export type Attestation = {
  caseId: Hex;
  payee: Address;
  token: Address;
  maxAmount: bigint;
  ruleVersion: Hex;
  evidenceHash: Hex;
  expiry: bigint;
};

export const ATTESTATION_TYPES = {
  Attestation: [
    { name: "caseId", type: "bytes32" },
    { name: "payee", type: "address" },
    { name: "token", type: "address" },
    { name: "maxAmount", type: "uint256" },
    { name: "ruleVersion", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export function attestationDomain(chainId: number, verifyingContract: Address) {
  return { name: "AgoranomosSettlement", version: "1", chainId, verifyingContract } as const;
}

const attestationTuple = {
  type: "tuple",
  components: [
    { name: "caseId", type: "bytes32" },
    { name: "payee", type: "address" },
    { name: "token", type: "address" },
    { name: "maxAmount", type: "uint256" },
    { name: "ruleVersion", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export const SETTLEMENT_ABI = [
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "a", ...attestationTuple },
      { name: "signature", type: "bytes" },
      { name: "amount", type: "uint256" },
      { name: "intentSeq", type: "uint256" },
      { name: "reasoningHash", type: "bytes32" },
    ],
    outputs: [],
  },
  { type: "function", name: "nextIntent", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "attestationDigest",
    stateMutability: "view",
    inputs: [{ name: "a", ...attestationTuple }],
    outputs: [{ type: "bytes32" }],
  },
  { type: "function", name: "paid", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ruleVersion", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "verifier", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "agent", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "setPayee",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "bool" }],
    outputs: [],
  },
  { type: "function", name: "allowedPayee", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "error", name: "NotOwner", inputs: [] },
  { type: "error", name: "NotAgent", inputs: [] },
  { type: "error", name: "ForgedAttestation", inputs: [] },
  { type: "error", name: "MalleableSignature", inputs: [] },
  { type: "error", name: "AttestationExpired", inputs: [] },
  { type: "error", name: "WrongToken", inputs: [] },
  { type: "error", name: "WrongRuleVersion", inputs: [] },
  { type: "error", name: "PayeeNotAllowed", inputs: [] },
  {
    type: "error",
    name: "ExceedsAttestedMaximum",
    inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
  },
  {
    type: "error",
    name: "ExceedsPeriodBudget",
    inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
  },
  { type: "error", name: "IntentAlreadyUsed", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "NothingPending", inputs: [] },
  { type: "error", name: "InvalidRoles", inputs: [] },
  { type: "error", name: "PendingPolicyRevoked", inputs: [] },
  { type: "error", name: "PendingAlreadyOpen", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "Reentrant", inputs: [] },
  { type: "error", name: "TransferFailed", inputs: [] },
  {
    type: "event",
    name: "Settled",
    inputs: [
      { name: "caseId", type: "bytes32", indexed: true },
      { name: "payee", type: "address", indexed: true },
      { name: "intentSeq", type: "uint256", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "paidToDate", type: "uint256", indexed: false },
      { name: "evidenceHash", type: "bytes32", indexed: false },
      { name: "ruleVersion", type: "bytes32", indexed: false },
      { name: "reasoningHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Escalated",
    inputs: [
      { name: "caseId", type: "bytes32", indexed: true },
      { name: "payee", type: "address", indexed: true },
      { name: "intentSeq", type: "uint256", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "payeeSpentThisPeriod", type: "uint256", indexed: false },
      { name: "evidenceHash", type: "bytes32", indexed: false },
      { name: "reasoningHash", type: "bytes32", indexed: false },
    ],
  },
] as const;

export const ERC20_ABI = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
