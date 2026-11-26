/**
 * Pay402 demo agent: buys one item from the merchant API, paying per call inside its allowance.
 *
 *   pnpm example pay402-agent                  # act 1: pay 0.50 tUSD8 for the weather feed
 *   pnpm example pay402-agent -- --inflate     # act 2: merchant quotes 100x -> agent REFUSES
 *   pnpm example pay402-agent -- --revoke-first # act 3: owner revokes -> agent REFUSES
 *
 * The agent never pays blindly. Before signing it checks, on chain and off:
 *   1. the merchant's quote signature really comes from the merchant,
 *   2. the merchant is in its allowlist, 3. the price is within its per-call cap,
 *   4. the spend stays inside its total budget, 5. the allowance is not revoked or expired.
 * A refusal is a designed outcome: the script prints REFUSED and exits 0.
 * The contract re-checks everything on chain, so even a tricked agent cannot overspend.
 *
 * Env (examples/.env): PAY402_ADDRESS, OWNER_KEY, AGENT_KEY, SERVER_URL, RPC_URL.
 * Keys are throwaway TEST wallets only.
 */
import { formatUnits, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  pay402Abi,
  paymentIntentTypedData,
  quoteTypes,
  quoteTypedData,
  splitSignature,
  TUSD8_DECIMALS,
  txUrl,
  type PaymentIntent,
  type Quote,
} from "@aevum-kit/aevum";
import { connect, requiredAddress, requiredKey } from "./env";

const args = process.argv.slice(2);
const inflate = args.includes("--inflate");
const revokeFirst = args.includes("--revoke-first");
const itemFlag = args.indexOf("--item");
const item = itemFlag >= 0 ? (args[itemFlag + 1] ?? "weather") : "weather";

const { client, chain } = await connect();
const pay402 = requiredAddress("PAY402_ADDRESS");
const owner = privateKeyToAccount(requiredKey("OWNER_KEY"));
const agent = privateKeyToAccount(requiredKey("AGENT_KEY"));
const serverUrl = (process.env.SERVER_URL ?? "http://127.0.0.1:4020").replace(/\/$/, "");

const PER_CALL_CAP = BigInt(Math.round(Number(process.env.PAY402_PER_CALL_CAP_TUSD8 ?? "2") * 1e6)); // 2.00 tUSD8
const TOTAL_BUDGET = BigInt(Math.round(Number(process.env.PAY402_TOTAL_BUDGET_TUSD8 ?? "100") * 1e6)); // 100.00 tUSD8

const check = (ok: boolean, label: string, detail?: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
};
const refuse = (reason: string): never => {
  console.log(`\n✗ REFUSED — ${reason}`);
  console.log("  The agent did not sign anything. No funds moved.");
  process.exit(0);
};

console.log(`Agent ${agent.address} buying "${item}" from ${serverUrl}${inflate ? " (inflated quote)" : ""}`);
console.log(`Owner ${owner.address} | Pay402 ${pay402} | chain ${chain.id}`);

// ---- merchant address (from the server's health endpoint) ----
const health = (await (await fetch(`${serverUrl}/health`)).json()) as { merchant: Address };
const merchant = health.merchant;
console.log(`Merchant ${merchant}`);

// ---- owner setup: approve + allowance, once ----
const { createWalletClient, http } = await import("viem");
const ownerClient = createWalletClient({ account: owner, chain, transport: http(process.env.RPC_URL) });
const allowance = await client.readContract({
  address: pay402,
  abi: pay402Abi,
  functionName: "allowanceOf",
  args: [owner.address, agent.address],
});
if (allowance.agent === "0x0000000000000000000000000000000000000000" || allowance.revoked) {
  console.log("\nSetting up the allowance (owner approves + creates it)...");
  const { erc20Abi } = await import("@aevum-kit/aevum");
  const token = await client.readContract({ address: pay402, abi: pay402Abi, functionName: "token" });
  const approveHash = await ownerClient.writeContract({
    account: owner,
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [pay402, TOTAL_BUDGET],
    type: "legacy",
  });
  await client.waitForTransactionReceipt({ hash: approveHash });
  console.log(`  approved ${formatUnits(TOTAL_BUDGET, TUSD8_DECIMALS)} tUSD8 for Pay402`);
  const createHash = await ownerClient.writeContract({
    account: owner,
    address: pay402,
    abi: pay402Abi,
    functionName: "createAllowance",
    args: [agent.address, [merchant], PER_CALL_CAP, TOTAL_BUDGET, BigInt(Math.floor(Date.now() / 1000) + 30 * 86400)],
    type: "legacy",
  });
  await client.waitForTransactionReceipt({ hash: createHash });
  console.log(
    `  allowance: per-call cap ${formatUnits(PER_CALL_CAP, TUSD8_DECIMALS)} tUSD8, budget ${formatUnits(TOTAL_BUDGET, TUSD8_DECIMALS)} tUSD8, merchant allowlisted`,
  );
}

if (revokeFirst) {
  console.log("\nOwner revokes the agent mid-demo...");
  const revokeHash = await ownerClient.writeContract({
    account: owner,
    address: pay402,
    abi: pay402Abi,
    functionName: "revokeAgent",
    args: [agent.address],
    type: "legacy",
  });
  await client.waitForTransactionReceipt({ hash: revokeHash });
  console.log("  agent revoked on chain.");
}

// ---- step 1: ask for the data, get a 402 with the merchant's signed quote ----
console.log("\nStep 1: request the data...");
const res = await fetch(`${serverUrl}/data?item=${item}${inflate ? "&inflate=100" : ""}`);
if (res.status === 200) {
  console.log("  already paid? got the data without paying — unexpected in this demo.");
  console.log(await res.text());
  process.exit(0);
}
if (res.status !== 402) {
  console.error(`  unexpected status ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const body = (await res.json()) as {
  orderId: Hex;
  amount: string;
  validBefore: string;
  quote: Quote;
  quoteSignature: Hex;
};
const amount = BigInt(body.amount);
const validBefore = BigInt(body.validBefore);
console.log(`  402: ${formatUnits(amount, TUSD8_DECIMALS)} tUSD8 for order ${body.orderId}`);

// ---- step 2: the agent's policy checks ----
console.log("\nStep 2: policy checks (the agent decides whether to pay)...");
const quoteSigner = await recoverTypedDataAddress({
  ...quoteTypedData(chain.id, pay402, body.quote),
  signature: body.quoteSignature,
});
let ok = true;
ok = check(quoteSigner.toLowerCase() === merchant.toLowerCase(), "quote is really signed by the merchant", `signer ${quoteSigner}`) && ok;
const [allowed, fresh] = await Promise.all([
  client.readContract({
    address: pay402,
    abi: pay402Abi,
    functionName: "isMerchantAllowed",
    args: [owner.address, agent.address, merchant],
  }),
  client.readContract({
    address: pay402,
    abi: pay402Abi,
    functionName: "allowanceOf",
    args: [owner.address, agent.address],
  }),
]);
ok = check(allowed, "merchant is in the allowlist") && ok;
ok = check(amount <= fresh.perCallCap, "price is within the per-call cap", `${formatUnits(amount, TUSD8_DECIMALS)} <= ${formatUnits(fresh.perCallCap, TUSD8_DECIMALS)} tUSD8`) && ok;
ok = check(fresh.spent + amount <= fresh.totalBudget, "spend stays inside the total budget", `spent ${formatUnits(fresh.spent, TUSD8_DECIMALS)} + ${formatUnits(amount, TUSD8_DECIMALS)} <= ${formatUnits(fresh.totalBudget, TUSD8_DECIMALS)} tUSD8`) && ok;
ok = check(!fresh.revoked, "allowance is not revoked") && ok;
const now = BigInt(Math.floor(Date.now() / 1000));
ok = check(now < fresh.expiresAt, "allowance is not expired") && ok;
ok = check(now < validBefore, "quote is not expired") && ok;
if (!ok) refuse("a policy check failed — see the ✗ above.");
console.log("  all checks passed.");

// ---- step 3: sign the intent, let the relayer settle it ----
console.log("\nStep 3: sign the payment intent and hand it to the relayer...");
const intent: PaymentIntent = {
  owner: owner.address,
  agent: agent.address,
  merchant,
  amount,
  orderId: body.orderId,
  validBefore,
};
const intentSignature = await agent.signTypedData({ ...paymentIntentTypedData(chain.id, pay402, intent) });
const relayRes = await fetch(`${serverUrl}/relay`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    intent: { ...intent, amount: intent.amount.toString(), validBefore: intent.validBefore.toString() },
    quoteSig: splitSignature(body.quoteSignature),
    intentSig: splitSignature(intentSignature),
  }),
});
const relayBody = (await relayRes.json()) as { hash?: Hex; error?: string };
if (!relayRes.ok || !relayBody.hash) {
  refuse(`the relayer / chain refused the payment: ${relayBody.error ?? relayRes.status}`);
}
const txHash = relayBody.hash as Hex;
console.log(`  settled on chain: ${txUrl(txHash)}`);

// ---- step 4: retry with the payment proof, get the data ----
console.log("\nStep 4: retry with the payment proof...");
const paidRes = await fetch(`${serverUrl}/data?item=${item}`, {
  headers: { "X-PAYMENT": JSON.stringify({ txHash, orderId: body.orderId }) },
});
if (paidRes.status !== 200) {
  console.error(`  unexpected status ${paidRes.status}: ${await paidRes.text()}`);
  process.exit(1);
}
const paid = (await paidRes.json()) as { data: unknown };
console.log("  200 — data received:");
console.log(`  ${JSON.stringify(paid.data)}`);
const isPaid = await client.readContract({
  address: pay402,
  abi: pay402Abi,
  functionName: "isOrderPaid",
  args: [body.orderId],
});
console.log(`\n✓ Paid ${formatUnits(amount, TUSD8_DECIMALS)} tUSD8. Receipt confirmed on chain: ${isPaid}`);
