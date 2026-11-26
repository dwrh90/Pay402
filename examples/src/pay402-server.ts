/**
 * Pay402 demo server: a merchant API that answers HTTP 402, plus the relayer that settles.
 *
 * Two roles, one process (kept separate in the code so the demo is easy to follow):
 *   MERCHANT  GET  /data?item=<name>          -> 402 with a signed price quote, or 200 with the
 *                                               data once a payment is verified on chain.
 *             GET  /health                    -> merchant / relayer / contract addresses.
 *   RELAYER   POST /relay                     -> simulates Pay402.executePayment, then submits it
 *                                               and pays the gas. Same rails as the starter kit's
 *                                               relay route: only our Pay402, only the quoted
 *                                               price, simulate first, 1-hour window, rate limits.
 *
 *   pnpm example pay402-server
 *
 * Env (examples/.env): PAY402_ADDRESS, MERCHANT_KEY, RELAYER_KEY, RPC_URL, PORT (default 4020).
 * Keys are throwaway TEST wallets only.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import {
  pay402Abi,
  quoteTypedData,
  splitSignature,
  TUSD8_ADDRESS,
  TUSD8_DECIMALS,
  txUrl,
  type Quote,
} from "@aevum-kit/aevum";
import { connect, requiredAddress, requiredKey } from "./env";

const { client, chain, rpcUrl } = await connect();
const pay402 = requiredAddress("PAY402_ADDRESS");
const merchant = privateKeyToAccount(requiredKey("MERCHANT_KEY"));
const relayer = privateKeyToAccount(requiredKey("RELAYER_KEY"), { nonceManager });
const relayerClient = createWalletClient({ account: relayer, chain, transport: http(rpcUrl) });
const port = Number(process.env.PORT ?? 4020);

// ---- the merchant's catalog: fixed prices in tUSD8 base units (6 decimals) ----
const CATALOG: Record<string, { price: bigint; data: (now: Date) => unknown }> = {
  weather: {
    price: 500_000n, // 0.50 tUSD8
    data: (now) => ({
      city: "Jakarta",
      tempC: 31,
      condition: "Partly cloudy",
      humidityPct: 78,
      updatedAt: now.toISOString(),
    }),
  },
  prices: {
    price: 1_000_000n, // 1.00 tUSD8
    data: (now) => ({
      tUSD8: "1.00",
      tQDAY: "0.02",
      BTC: "97400",
      ETH: "3410",
      updatedAt: now.toISOString(),
    }),
  },
};

// orderId -> what was quoted (the price rail: the relayer only settles the quoted price)
interface QuotedOrder {
  item: string;
  price: bigint;
  validBefore: bigint;
}
const orders = new Map<string, QuotedOrder>();

// ---- relayer rails (same shape as the starter kit's relay route) ----
const MAX_WINDOW_SECONDS = 3600n;
const PER_IP_PER_MINUTE = 10;
const DAILY_TX_LIMIT = 500;
const IN_FLIGHT_MS = 120_000;
const hits = new Map<string, number[]>();
function limited(bucket: string, max: number): boolean {
  const now = Date.now();
  const recent = (hits.get(bucket) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(bucket, recent);
  return recent.length > max;
}
let day = "";
let sentToday = 0;
function overDailyLimit(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    sentToday = 0;
  }
  return sentToday >= DAILY_TX_LIMIT;
}
const inFlight = new Map<string, number>();
function claimInFlight(key: string): boolean {
  const now = Date.now();
  for (const [k, t] of inFlight) if (now - t > IN_FLIGHT_MS) inFlight.delete(k);
  if (inFlight.has(key)) return false;
  inFlight.set(key, now);
  return true;
}

// ---- small http helpers ----
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",").at(-1)?.trim() || "unknown";
  return req.socket.remoteAddress || "unknown";
}

const PAID_TOPIC = keccak256(toHex("Paid(bytes32,address,address,address,uint256)"));

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  const now = BigInt(Math.floor(Date.now() / 1000));

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      chain: `${chain.name} (${chain.id})`,
      pay402,
      merchant: merchant.address,
      relayer: relayer.address,
      items: Object.fromEntries(
        Object.entries(CATALOG).map(([k, v]) => [k, `${formatUnits(v.price, TUSD8_DECIMALS)} tUSD8`]),
      ),
    });
  }

  if (req.method === "GET" && url.pathname === "/data") {
    const item = url.searchParams.get("item") ?? "weather";
    const entry = CATALOG[item];
    if (!entry) return json(res, 404, { error: `Unknown item: ${item}` });
    const inflate = url.searchParams.get("inflate") === "100";
    const price = inflate ? entry.price * 100n : entry.price;

    // A payment proof was supplied: verify it on chain, then serve the data.
    const paymentHeader = req.headers["x-payment"];
    if (typeof paymentHeader === "string") {
      try {
        const proof = JSON.parse(paymentHeader) as { txHash?: string; orderId?: string };
        const quoted = proof.orderId ? orders.get(proof.orderId) : undefined;
        if (!proof.txHash || !quoted) return json(res, 402, { error: "Unknown order. Request /data first." });
        const receipt = await client.getTransactionReceipt({ hash: proof.txHash as Hex });
        const paid = receipt.logs.some((log) => {
          if (log.address.toLowerCase() !== pay402.toLowerCase()) return false;
          if (log.topics[0] !== PAID_TOPIC || log.topics[1] !== proof.orderId) return false;
          // data = merchant (32 bytes) + amount (32 bytes)
          const amount = BigInt(`0x${log.data.slice(66, 130)}`);
          return amount === quoted.price;
        });
        if (receipt.status !== "success" || !paid) {
          return json(res, 402, { error: "Payment not verified on chain for this order." });
        }
        console.log(`[merchant] served ${item} for order ${proof.orderId} (tx ${proof.txHash})`);
        return json(res, 200, { item, data: entry.data(new Date()), paidInTx: proof.txHash });
      } catch {
        return json(res, 402, { error: "Invalid X-PAYMENT header." });
      }
    }

    // No payment yet: answer 402 with the merchant-signed quote.
    const orderId = keccak256(toHex(`pay402-${merchant.address}-${item}-${Date.now()}-${Math.random()}`));
    const validBefore = now + 600n;
    const quote: Quote = { merchant: merchant.address, orderId, amount: price, validBefore };
    const signature = await merchant.signTypedData({
      ...quoteTypedData(chain.id, pay402, quote),
    });
    orders.set(orderId, { item, price, validBefore });
    console.log(
      `[merchant] 402 ${item} ${formatUnits(price, TUSD8_DECIMALS)} tUSD8 order ${orderId}${inflate ? " (INFLATED x100)" : ""}`,
    );
    return json(res, 402, {
      error: "Payment Required",
      accepts: [
        {
          scheme: "x402-pay402",
          network: `${chain.name} (${chain.id})`,
          asset: TUSD8_ADDRESS,
          amount: price.toString(),
          payTo: merchant.address,
        },
      ],
      item,
      orderId,
      amount: price.toString(),
      validBefore: validBefore.toString(),
      quote,
      quoteSignature: signature,
    });
  }

  if (req.method === "POST" && url.pathname === "/relay") {
    if (limited(`ip:${clientIp(req)}`, PER_IP_PER_MINUTE)) {
      return json(res, 429, { error: "Too many requests. Wait a minute." });
    }
    const body = await readBody(req);
    const intent = body.intent as Record<string, unknown> | undefined;
    const quoteSig = body.quoteSig as { v?: number; r?: string; s?: string } | undefined;
    const intentSig = body.intentSig as { v?: number; r?: string; s?: string } | undefined;
    if (
      !intent ||
      typeof intent.owner !== "string" ||
      typeof intent.agent !== "string" ||
      typeof intent.merchant !== "string" ||
      typeof intent.amount !== "string" ||
      typeof intent.orderId !== "string" ||
      typeof intent.validBefore !== "string" ||
      !quoteSig?.r ||
      !quoteSig?.s ||
      !intentSig?.r ||
      !intentSig?.s
    ) {
      return json(res, 400, { error: "Malformed payment request." });
    }
    const amount = BigInt(intent.amount);
    const validBefore = BigInt(intent.validBefore);
    // Rail 1: only a price this server actually quoted, for this order.
    const quoted = orders.get(intent.orderId);
    if (!quoted || quoted.price !== amount || intent.merchant !== merchant.address) {
      return json(res, 400, { error: "The amount doesn't match this order's price." });
    }
    if (validBefore > now + MAX_WINDOW_SECONDS || validBefore <= now) {
      return json(res, 400, { error: "Signature window is invalid (max 1 hour, must be in the future)." });
    }
    const flightKey = `${chain.id}:${intent.orderId}`;
    if (!claimInFlight(flightKey)) {
      return json(res, 409, { error: "This order is already being submitted." });
    }
    try {
      // Rail 2: not already paid.
      const paid = await client.readContract({
        address: pay402,
        abi: pay402Abi,
        functionName: "isOrderPaid",
        args: [intent.orderId as Hex],
      });
      if (paid) {
        inFlight.delete(flightKey);
        return json(res, 409, { error: "This order is already paid." });
      }
      if (overDailyLimit()) {
        inFlight.delete(flightKey);
        return json(res, 503, { error: "The relayer reached its daily limit." });
      }
      const args = [
        {
          owner: intent.owner as Address,
          agent: intent.agent as Address,
          merchant: intent.merchant as Address,
          amount,
          orderId: intent.orderId as Hex,
          validBefore,
        },
        { v: quoteSig.v ?? 27, r: quoteSig.r as Hex, s: quoteSig.s as Hex },
        { v: intentSig.v ?? 27, r: intentSig.r as Hex, s: intentSig.s as Hex },
      ] as const;
      // Rail 3: simulate first, so a bad signature or a refused payment costs nothing.
      await client.simulateContract({
        account: relayer,
        address: pay402,
        abi: pay402Abi,
        functionName: "executePayment",
        args,
      });
      const hash = await relayerClient.writeContract({
        account: relayer,
        address: pay402,
        abi: pay402Abi,
        functionName: "executePayment",
        args,
        type: "legacy",
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      sentToday++;
      console.log(`[relayer] settled order ${intent.orderId} in ${txUrl(hash)} (block ${receipt.blockNumber})`);
      return json(res, 200, { hash, blockNumber: receipt.blockNumber.toString(), status: receipt.status });
    } catch (e) {
      inFlight.delete(flightKey);
      const message = e instanceof Error ? e.message.split("\n")[0] : "Simulation failed.";
      console.log(`[relayer] refused order ${intent.orderId}: ${message}`);
      return json(res, 400, { error: message });
    }
  }

  return json(res, 404, { error: "Not found. Try GET /health or GET /data?item=weather" });
});

server.listen(port, () => {
  console.log(`Pay402 demo server on http://127.0.0.1:${port}`);
  console.log(`  chain    ${chain.name} (${chain.id})`);
  console.log(`  pay402   ${pay402}`);
  console.log(`  merchant ${merchant.address}`);
  console.log(`  relayer  ${relayer.address}`);
  console.log(`  items    ${Object.entries(CATALOG).map(([k, v]) => `${k} ${formatUnits(v.price, TUSD8_DECIMALS)} tUSD8`).join(", ")}`);
});
