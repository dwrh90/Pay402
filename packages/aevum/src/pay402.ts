import { parseAbi, type Address, type Hex } from "viem";

/** ABI of contracts/src/Pay402.sol. */
export const pay402Abi = parseAbi([
  "function token() view returns (address)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function createAllowance(address agent, address[] merchants, uint256 perCallCap, uint256 totalBudget, uint256 expiresAt)",
  "function setMerchantAllowed(address agent, address merchant, bool allowed)",
  "function updateCaps(address agent, uint256 perCallCap, uint256 totalBudget, uint256 expiresAt)",
  "function revokeAgent(address agent)",
  "function executePayment((address owner, address agent, address merchant, uint256 amount, bytes32 orderId, uint256 validBefore) intent, (uint8 v, bytes32 r, bytes32 s) quoteSig, (uint8 v, bytes32 r, bytes32 s) intentSig)",
  "function allowanceOf(address owner, address agent) view returns ((address agent, uint256 perCallCap, uint256 totalBudget, uint256 spent, uint256 expiresAt, bool revoked))",
  "function isMerchantAllowed(address owner, address agent, address merchant) view returns (bool)",
  "function isOrderPaid(bytes32 orderId) view returns (bool)",
  "function remainingBudget(address owner, address agent) view returns (uint256)",
  "event AllowanceSet(address indexed owner, address indexed agent, uint256 perCallCap, uint256 totalBudget, uint256 expiresAt)",
  "event MerchantAllowed(address indexed owner, address indexed agent, address indexed merchant, bool allowed)",
  "event AgentRevoked(address indexed owner, address indexed agent)",
  "event Paid(bytes32 indexed orderId, address indexed owner, address indexed agent, address merchant, uint256 amount)",
  "error ZeroAmount()",
  "error ZeroAddress()",
  "error AllowanceExpired()",
  "error AgentNotConfigured()",
  "error AgentIsRevoked()",
  "error MerchantNotAllowed()",
  "error ExceedsPerCallCap()",
  "error ExceedsBudget()",
  "error IntentExpired()",
  "error InvalidQuote()",
  "error InvalidIntent()",
  "error AlreadyPaid(bytes32 orderId)",
]);

/** EIP-712 domain of Pay402 (matches EIP712("Pay402", "1") in the contract). */
export function pay402Domain(chainId: number, verifyingContract: Address) {
  return { name: "Pay402", version: "1", chainId, verifyingContract } as const;
}

/** EIP-712 types for a merchant's signed price quote. */
export const quoteTypes = {
  Quote: [
    { name: "merchant", type: "address" },
    { name: "orderId", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "validBefore", type: "uint256" },
  ],
} as const;

export interface Quote {
  merchant: Address;
  orderId: Hex;
  amount: bigint;
  validBefore: bigint;
}

export function quoteTypedData(chainId: number, pay402: Address, message: Quote) {
  return {
    domain: pay402Domain(chainId, pay402),
    types: quoteTypes,
    primaryType: "Quote" as const,
    message,
  };
}

/** EIP-712 types for the agent's signed request to pay one order. */
export const paymentIntentTypes = {
  PaymentIntent: [
    { name: "owner", type: "address" },
    { name: "agent", type: "address" },
    { name: "merchant", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "orderId", type: "bytes32" },
    { name: "validBefore", type: "uint256" },
  ],
} as const;

export interface PaymentIntent {
  owner: Address;
  agent: Address;
  merchant: Address;
  amount: bigint;
  orderId: Hex;
  validBefore: bigint;
}

export function paymentIntentTypedData(chainId: number, pay402: Address, message: PaymentIntent) {
  return {
    domain: pay402Domain(chainId, pay402),
    types: paymentIntentTypes,
    primaryType: "PaymentIntent" as const,
    message,
  };
}

/** Split a 65-byte signature into the (v, r, s) the contract expects. */
export function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  let v = Number.parseInt(signature.slice(130, 132), 16);
  if (v < 27) v += 27;
  return { v, r, s };
}
