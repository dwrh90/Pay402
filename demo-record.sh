#!/usr/bin/env bash
# Pay402 demo video driver — runs the three acts live on Aevum testnet.
# Run inside a terminal (xterm under Xvfb, or under `script` for capture).
# The server starts detached; this terminal only shows the agent runs.
set -u
cd ~/workspace/qday-pay402

say() { printf "\n=== %s ===\n\n" "$1"; sleep 2; }

clear
echo "Pay402 — pay-per-request for AI agents, on QDay Aevum testnet"
echo "An agent that buys data per call, inside an owner-controlled budget."
echo "Contract: 0x87b9AB230DB7323A4b92F3312BD115667998CB26 (chain 44005)"
sleep 4

say "Starting the merchant server (402 + relayer)"
echo "$ pnpm example pay402-server   # runs in the background"
pkill -f "pay402-server" 2>/dev/null; sleep 1
nohup pnpm example pay402-server > /tmp/pay402-server.log 2>&1 &
sleep 8
curl -s http://127.0.0.1:4020/health | head -c 200; echo
sleep 3

say "ACT 1 — the agent pays 0.50 tUSD8 for weather data"
echo "$ pnpm example pay402-agent"
pnpm example pay402-agent 2>&1 | grep -v "^> " | grep -v "^\s*$"
sleep 5

say "ACT 2 — the merchant quotes 100x the price. The agent refuses."
echo "$ pnpm example pay402-agent -- --inflate"
pnpm example pay402-agent -- --inflate 2>&1 | grep -v "^> " | grep -v "^\s*$"
sleep 5

say "ACT 3 — the owner revokes the agent mid-demo. The agent refuses."
echo "$ pnpm example pay402-agent -- --revoke-first"
pnpm example pay402-agent -- --revoke-first 2>&1 | grep -v "^> " | grep -v "^\s*$"
sleep 5

say "Receipts"
echo "Deploy tx: https://explorer-test.qday.info/tx/0xf8311f4ebcd296d4b978d773822b2f6cb44d5116558b819ee9303767f125aa80"
echo "Act 1 payment tx: see the explorer link printed in Act 1 above."
echo "Dashboard: web/src/app/dashboard — allowance, spend vs budget, revoke, receipts."
echo ""
echo "Pay402 — the agent buys, and it can say no."
sleep 4
