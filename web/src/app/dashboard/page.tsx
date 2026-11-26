"use client";

import { erc20Abi, getLogsChunked, pay402Abi, txUrl } from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { formatUnits, getAbiItem, isAddress, parseUnits, type Address, type Hash, type PublicClient } from "viem";
import { useAccount, useConfig, usePublicClient, useReadContract } from "wagmi";
import { simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useNetwork } from "@/lib/network";
import { explain } from "@/lib/errors";
import { orderLabel, short } from "@/lib/order";

// The demo identities from examples/.env (throwaway TEST wallets, public addresses).
const DEMO_OWNER = "0x498AA59219c852955e52782eD193B289Af1AaF91" as Address;
const DEMO_AGENT = "0x2cCf9bCc933eEb5AaeCf49EFb77345D0AeEfFF76" as Address;
const DEMO_MERCHANT = "0x1A905a071F8E0Bc56a9d788b29c83c39aa189A46" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

type Phase = "idle" | "working" | "done" | "error";

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 10px",
  border: "1px solid var(--line)",
  borderRadius: 8,
  background: "var(--surface)",
  color: "var(--text)",
  fontFamily: "var(--font-jetbrains), monospace",
  fontSize: 13,
};

export default function DashboardPage() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const pay402 = net.pay402;
  const deployBlock = net.deployBlock;
  const hasExplorer = net.hasExplorer;
  const config = useConfig();
  const client = usePublicClient({ chainId: appChain.id }) as PublicClient | undefined;
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === appChain.id;

  const [ownerInput, setOwnerInput] = useState("");
  const [agentInput, setAgentInput] = useState("");
  const [merchantInput, setMerchantInput] = useState<string>(DEMO_MERCHANT);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hash | null>(null);
  const [revokeArmed, setRevokeArmed] = useState(false);
  const [newAgent, setNewAgent] = useState("");
  const [newMerchant, setNewMerchant] = useState<string>(DEMO_MERCHANT);
  const [newCap, setNewCap] = useState("2");
  const [newBudget, setNewBudget] = useState("100");
  const [newDays, setNewDays] = useState("30");

  // Owner defaults to the connected wallet; agent to the demo agent.
  useEffect(() => {
    if (address && !ownerInput) setOwnerInput(address);
  }, [address, ownerInput]);
  useEffect(() => {
    if (!agentInput) setAgentInput(DEMO_AGENT);
  }, [agentInput]);

  const owner = isAddress(ownerInput) ? (ownerInput as Address) : undefined;
  const agent = isAddress(agentInput) ? (agentInput as Address) : undefined;
  const merchant = isAddress(merchantInput) ? (merchantInput as Address) : undefined;
  const isOwner = onChain && address?.toLowerCase() === owner?.toLowerCase();

  const allowance = useReadContract({
    address: pay402,
    abi: pay402Abi,
    functionName: "allowanceOf",
    args: owner && agent ? [owner, agent] : undefined,
    chainId: appChain.id,
    query: { enabled: Boolean(pay402 && owner && agent) },
  });
  const tokenAddress = useReadContract({
    address: pay402,
    abi: pay402Abi,
    functionName: "token",
    chainId: appChain.id,
    query: { enabled: Boolean(pay402) },
  });
  const tokenMeta = useReadContract({
    address: tokenAddress.data,
    abi: erc20Abi,
    functionName: "decimals",
    chainId: appChain.id,
    query: { enabled: Boolean(tokenAddress.data) },
  });
  const decimals = (tokenMeta.data as number | undefined) ?? 6;
  const allowed = useReadContract({
    address: pay402,
    abi: pay402Abi,
    functionName: "isMerchantAllowed",
    args: owner && agent && merchant ? [owner, agent, merchant] : undefined,
    chainId: appChain.id,
    query: { enabled: Boolean(pay402 && owner && agent && merchant) },
  });

  const receipts = useQuery({
    queryKey: ["pay402-logs", appChain.id, pay402, agent],
    enabled: Boolean(client && pay402 && agent),
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      let from = head > 5_000n ? head - 5_000n + 1n : 0n;
      if (deployBlock !== undefined && deployBlock > from) from = deployBlock;
      const result = await getLogsChunked(client!, {
        address: pay402!,
        event: getAbiItem({ abi: pay402Abi, name: "Paid" }),
        args: agent ? { agent } : undefined,
        fromBlock: from,
        toBlock: head,
      });
      return { from, head, items: [...result].reverse() };
    },
  });

  const a = allowance.data;
  const configured = a !== undefined && a.agent !== ZERO;
  const now = Math.floor(Date.now() / 1000);
  const status = !configured ? "No allowance" : a.revoked ? "Revoked" : now > Number(a.expiresAt) ? "Expired" : "Active";
  const spent = a?.spent ?? 0n;
  const budget = a?.totalBudget ?? 0n;
  const usedPct = budget > 0n ? Number((spent * 100n) / budget) : 0;

  function refresh() {
    void allowance.refetch();
    void allowed.refetch();
    void receipts.refetch();
  }

  async function runTx(label: string, fn: () => Promise<Hash>) {
    setError(null);
    setTxHash(null);
    setPhase("working");
    try {
      const hash = await fn();
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain.");
      setTxHash(hash);
      setPhase("done");
      refresh();
    } catch (e) {
      setError(explain(e));
      setPhase("error");
    }
  }

  async function onRevoke() {
    if (!agent || !isOwner) return;
    if (!revokeArmed) {
      setRevokeArmed(true);
      return;
    }
    setRevokeArmed(false);
    await runTx("revoke", async () => {
      const { request } = await simulateContract(config, {
        account: address,
        address: pay402!,
        abi: pay402Abi,
        functionName: "revokeAgent",
        args: [agent],
        chainId: appChain.id,
      });
      return writeContract(config, request);
    });
  }

  async function onCreate() {
    if (!agent || !isOwner) return;
    const cap = parseUnits(newCap || "0", decimals);
    const total = parseUnits(newBudget || "0", decimals);
    const days = Number(newDays || "0");
    const merchantAddr = isAddress(newMerchant) ? (newMerchant as Address) : undefined;
    const agentAddr = isAddress(newAgent) ? (newAgent as Address) : undefined;
    if (!merchantAddr || !agentAddr || cap === 0n || total === 0n || days <= 0) {
      setError("Fill in a valid agent, merchant, cap, budget and expiry (days).");
      setPhase("error");
      return;
    }
    const expiresAt = BigInt(now + days * 86400);
    await runTx("create", async () => {
      const { request } = await simulateContract(config, {
        account: address,
        address: pay402!,
        abi: pay402Abi,
        functionName: "createAllowance",
        args: [agentAddr, [merchantAddr], cap, total, expiresAt],
        chainId: appChain.id,
      });
      return writeContract(config, request);
    });
  }

  const busy = phase === "working";

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">Pay402 · Agent allowances</p>
          <h1>Agent dashboard</h1>
          <p className="lede">
            What an agent may spend, where, and how much is left. The policy lives on chain in Pay402 — the agent&apos;s key can only ever
            request payments, never move funds by itself.
          </p>
        </div>
        {configured && (
          <div className="score">
            <span className="score-num">{formatUnits(budget - spent, decimals)}</span>
            <span className="fine">tUSD8 left of {formatUnits(budget, decimals)}</span>
          </div>
        )}
      </div>

      {!pay402 ? (
        <div className="card empty">
          No Pay402 configured for {net.label}. Deploy it, then set <code>NEXT_PUBLIC_PAY402_{net.key.toUpperCase()}</code> in{" "}
          <code>web/.env.local</code>.
        </div>
      ) : (
        <>
          <div className="row">
            <section className="card stack" aria-label="Allowance" style={{ flex: "1.2 1 420px" }}>
              <div className="check-top" style={{ alignItems: "baseline" }}>
                <h2>Allowance</h2>
                <button type="button" className="btn small secondary" onClick={() => { setOwnerInput(DEMO_OWNER); setAgentInput(DEMO_AGENT); setMerchantInput(DEMO_MERCHANT); }}>
                  Load demo
                </button>
              </div>
              <label className="fine" htmlFor="owner">Owner (pays)</label>
              <input id="owner" style={inputStyle} value={ownerInput} onChange={(e) => setOwnerInput(e.target.value)} placeholder="0x…" spellCheck={false} />
              <label className="fine" htmlFor="agent">Agent (may request payments)</label>
              <input id="agent" style={inputStyle} value={agentInput} onChange={(e) => setAgentInput(e.target.value)} placeholder="0x…" spellCheck={false} />
              {allowance.isLoading && <p className="fine">Reading the allowance…</p>}
              {allowance.error && <p className="empty">Couldn&apos;t read the allowance: {(allowance.error as Error).message}</p>}
              {configured && a && (
                <>
                  <dl className="kv" style={{ fontSize: 13 }}>
                    <dt>Status</dt>
                    <dd>
                      <strong style={{ color: status === "Active" ? "var(--good)" : status === "Revoked" ? "var(--warn)" : "var(--bad)" }}>{status}</strong>
                    </dd>
                    <dt>Per-call cap</dt>
                    <dd>{formatUnits(a.perCallCap, decimals)} tUSD8</dd>
                    <dt>Total budget</dt>
                    <dd>{formatUnits(a.totalBudget, decimals)} tUSD8</dd>
                    <dt>Spent</dt>
                    <dd>{formatUnits(a.spent, decimals)} tUSD8</dd>
                    <dt>Expires</dt>
                    <dd>{new Date(Number(a.expiresAt) * 1000).toLocaleString()}</dd>
                    <dt>Pay402</dt>
                    <dd>{short(pay402)}</dd>
                  </dl>
                  <div>
                    <div className="progress" role="progressbar" aria-valuenow={usedPct} aria-valuemin={0} aria-valuemax={100}>
                      <span style={{ width: `${Math.min(usedPct, 100)}%` }} />
                    </div>
                    <p className="fine" style={{ marginTop: 6 }}>{usedPct}% of budget spent</p>
                  </div>
                  {isOwner && (
                    <button type="button" className="btn warn block" disabled={busy || a.revoked} onClick={onRevoke}>
                      {a.revoked ? "Agent revoked" : revokeArmed ? "Click again to confirm revoke" : "Revoke agent"}
                    </button>
                  )}
                  {!isOwner && (
                    <p className="fine">Connect the owner&apos;s wallet ({owner ? short(owner) : "—"}) to revoke or change this allowance.</p>
                  )}
                </>
              )}
              {!configured && !allowance.isLoading && (
                <p className="empty">No allowance for this owner + agent. Create one on the right — or run the demo agent script, which sets it up.</p>
              )}
            </section>

            <div className="stack" style={{ flex: "1 1 340px" }}>
              <section className="card stack" aria-label="New allowance">
                <h2>New allowance</h2>
                <p className="sub">Owner only. The agent gets no funds — just permission to request payments inside these limits.</p>
                <label className="fine" htmlFor="new-agent">Agent</label>
                <input id="new-agent" style={inputStyle} value={newAgent} onChange={(e) => setNewAgent(e.target.value)} placeholder="0x…" spellCheck={false} />
                <label className="fine" htmlFor="new-merchant">Merchant (allowlisted)</label>
                <input id="new-merchant" style={inputStyle} value={newMerchant} onChange={(e) => setNewMerchant(e.target.value)} placeholder="0x…" spellCheck={false} />
                <div style={{ display: "flex", gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <label className="fine" htmlFor="new-cap">Per-call cap (tUSD8)</label>
                    <input id="new-cap" style={inputStyle} value={newCap} onChange={(e) => setNewCap(e.target.value)} inputMode="decimal" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className="fine" htmlFor="new-budget">Total budget (tUSD8)</label>
                    <input id="new-budget" style={inputStyle} value={newBudget} onChange={(e) => setNewBudget(e.target.value)} inputMode="decimal" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className="fine" htmlFor="new-days">Expiry (days)</label>
                    <input id="new-days" style={inputStyle} value={newDays} onChange={(e) => setNewDays(e.target.value)} inputMode="numeric" />
                  </div>
                </div>
                <button type="button" className="btn big block" disabled={!isOwner || busy} onClick={onCreate}>
                  {!isConnected ? "Connect a wallet first" : !onChain ? "Switch network first" : !isOwner ? "Only the owner can create allowances" : busy ? "Check your wallet…" : "Create allowance"}
                </button>
              </section>

              <section className="card stack" aria-label="Merchant check">
                <h2>Merchant allowlist</h2>
                <label className="fine" htmlFor="merchant">Merchant address</label>
                <input id="merchant" style={inputStyle} value={merchantInput} onChange={(e) => setMerchantInput(e.target.value)} placeholder="0x…" spellCheck={false} />
                {allowed.data !== undefined && (
                  <p className="fine">
                    {allowed.data ? "✓ This merchant is allowlisted for the agent." : "✗ This merchant is NOT allowlisted — the agent's payments to it will be refused."}
                  </p>
                )}
                <button type="button" className="btn small secondary" disabled={busy} onClick={refresh}>Refresh</button>
              </section>
            </div>
          </div>

          {error && (
            <div className="notice bad" role="alert" style={{ marginTop: 16 }}>
              <strong>Something didn&apos;t go through</strong>
              <span>{error}</span>
            </div>
          )}
          {phase === "done" && txHash && (
            <div className="notice good" role="status" style={{ marginTop: 16 }}>
              <div className="row-between">
                <strong>Confirmed on chain</strong>
                <span style={{ display: "flex", gap: 16 }}>
                  {hasExplorer && (
                    <a href={txUrl(txHash)} target="_blank" rel="noreferrer">Explorer</a>
                  )}
                </span>
              </div>
            </div>
          )}

          <section className="card flush" style={{ marginTop: 16 }} aria-label="Receipts">
            <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--line)" }}>
              <h2 style={{ margin: 0 }}>Receipts</h2>
              <p className="fine" style={{ margin: "4px 0 0" }}>Every <code>Paid</code> event from Pay402 for this agent. A receipt is proof the money moved.</p>
            </div>
            {receipts.isFetching && <p className="empty">Scanning events…</p>}
            {receipts.error && <p className="empty">Couldn&apos;t read events: {(receipts.error as Error).message}</p>}
            {receipts.data && receipts.data.items.length === 0 && !receipts.isFetching && (
              <p className="empty">No payments yet for this agent in blocks {receipts.data.from.toString()}–{receipts.data.head.toString()}.</p>
            )}
            {receipts.data && receipts.data.items.length > 0 && (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Merchant</th>
                      <th className="right">Amount</th>
                      <th className="right">Block</th>
                      <th>Links</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receipts.data.items.map((l) => (
                      <tr key={`${l.transactionHash}-${l.logIndex}`}>
                        <td className="mono">{l.args.orderId ? orderLabel(l.args.orderId) : "—"}</td>
                        <td className="mono">{short(l.args.merchant ?? "")}</td>
                        <td className="right num">{formatUnits(l.args.amount ?? 0n, decimals)} tUSD8</td>
                        <td className="right num">{l.blockNumber?.toString()}</td>
                        <td>
                          {hasExplorer && l.transactionHash && (
                            <a href={txUrl(l.transactionHash)} target="_blank" rel="noreferrer">Tx</a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
