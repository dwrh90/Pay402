// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Pay402} from "../src/Pay402.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";

/// @notice Unit tests for Pay402 against the local MockUSD8 (same 6 decimals and EIP-712
///         domain as tUSD8). Run with: make test
contract Pay402Test is Test {
    MockUSD8 token;
    Pay402 pay402;

    address owner = makeAddr("owner");
    address relayer = makeAddr("relayer");
    address agent;
    uint256 agentPk;
    address merchant;
    uint256 merchantPk;

    bytes32 orderId = keccak256("order-1");
    uint256 validBefore;

    function setUp() public {
        (agent, agentPk) = makeAddrAndKey("agent");
        (merchant, merchantPk) = makeAddrAndKey("merchant");
        validBefore = block.timestamp + 1 hours;

        token = new MockUSD8();
        pay402 = new Pay402(token);

        token.mint(owner, 1_000e6);
        vm.prank(owner);
        token.approve(address(pay402), 1_000e6);

        address[] memory merchants = new address[](1);
        merchants[0] = merchant;
        vm.prank(owner);
        pay402.createAllowance(agent, merchants, 10e6, 100e6, block.timestamp + 30 days);
    }

    // ---- signing helpers (same EIP-712 construction a wallet uses) ----

    function _signQuote(uint256 pk, address m, bytes32 oid, uint256 amount, uint256 vb)
        internal
        view
        returns (Pay402.Signature memory sig)
    {
        bytes32 structHash = keccak256(abi.encode(pay402.QUOTE_TYPEHASH(), m, oid, amount, vb));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", pay402.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sig = Pay402.Signature(v, r, s);
    }

    function _signIntent(uint256 pk, address o, address a, address m, uint256 amount, bytes32 oid, uint256 vb)
        internal
        view
        returns (Pay402.Signature memory sig)
    {
        bytes32 structHash = keccak256(abi.encode(pay402.INTENT_TYPEHASH(), o, a, m, amount, oid, vb));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", pay402.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sig = Pay402.Signature(v, r, s);
    }

    /// @dev Build a fully signed payment WITHOUT submitting it. Tests that expect a revert
    ///      must sign first: vm.expectRevert only watches the next external call, and the
    ///      view calls inside the signing helpers would consume it.
    function _signed(uint256 amount, bytes32 oid, uint256 vb)
        internal
        view
        returns (
            Pay402.PaymentIntent memory intent,
            Pay402.Signature memory quoteSig,
            Pay402.Signature memory intentSig
        )
    {
        quoteSig = _signQuote(merchantPk, merchant, oid, amount, vb);
        intentSig = _signIntent(agentPk, owner, agent, merchant, amount, oid, vb);
        intent = Pay402.PaymentIntent(owner, agent, merchant, amount, oid, vb);
    }

    function _signedTo(address m, uint256 mPk, uint256 amount, bytes32 oid, uint256 vb)
        internal
        view
        returns (
            Pay402.PaymentIntent memory intent,
            Pay402.Signature memory quoteSig,
            Pay402.Signature memory intentSig
        )
    {
        quoteSig = _signQuote(mPk, m, oid, amount, vb);
        intentSig = _signIntent(agentPk, owner, agent, m, amount, oid, vb);
        intent = Pay402.PaymentIntent(owner, agent, m, amount, oid, vb);
    }

    function _pay(uint256 amount, bytes32 oid, uint256 vb) internal {
        (Pay402.PaymentIntent memory intent, Pay402.Signature memory qs, Pay402.Signature memory isig) =
            _signed(amount, oid, vb);
        vm.prank(relayer);
        pay402.executePayment(intent, qs, isig);
    }

    function _payTo(address m, uint256 mPk, uint256 amount, bytes32 oid, uint256 vb) internal {
        (Pay402.PaymentIntent memory intent, Pay402.Signature memory qs, Pay402.Signature memory isig) =
            _signedTo(m, mPk, amount, oid, vb);
        vm.prank(relayer);
        pay402.executePayment(intent, qs, isig);
    }

    // ---- allowance management ----

    function test_createAllowance_storesFields() public view {
        Pay402.Allowance memory a = pay402.allowanceOf(owner, agent);
        assertEq(a.agent, agent);
        assertEq(a.perCallCap, 10e6);
        assertEq(a.totalBudget, 100e6);
        assertEq(a.spent, 0);
        assertEq(a.expiresAt, block.timestamp + 30 days);
        assertFalse(a.revoked);
        assertTrue(pay402.isMerchantAllowed(owner, agent, merchant));
        assertEq(pay402.remainingBudget(owner, agent), 100e6);
    }

    function test_createAllowance_rejectsZeroAgent() public {
        address[] memory merchants = new address[](0);
        vm.prank(owner);
        vm.expectRevert(Pay402.ZeroAddress.selector);
        pay402.createAllowance(address(0), merchants, 10e6, 100e6, block.timestamp + 30 days);
    }

    function test_createAllowance_rejectsZeroCaps() public {
        address[] memory merchants = new address[](0);
        vm.prank(owner);
        vm.expectRevert(Pay402.ZeroAmount.selector);
        pay402.createAllowance(agent, merchants, 0, 100e6, block.timestamp + 30 days);
    }

    function test_createAllowance_rejectsPastExpiry() public {
        address[] memory merchants = new address[](0);
        vm.prank(owner);
        vm.expectRevert(Pay402.AllowanceExpired.selector);
        pay402.createAllowance(agent, merchants, 10e6, 100e6, block.timestamp);
    }

    function test_createAllowance_preservesSpentOnUpdate() public {
        _pay(5e6, orderId, validBefore);
        assertEq(pay402.allowanceOf(owner, agent).spent, 5e6);

        address[] memory merchants = new address[](0);
        vm.prank(owner);
        pay402.createAllowance(agent, merchants, 20e6, 200e6, block.timestamp + 60 days);
        Pay402.Allowance memory a = pay402.allowanceOf(owner, agent);
        assertEq(a.spent, 5e6, "re-issuing must not reset spent");
        assertEq(a.perCallCap, 20e6);
        assertEq(a.totalBudget, 200e6);
        assertFalse(a.revoked);
    }

    function test_setMerchantAllowed_blocksMerchant() public {
        vm.prank(owner);
        pay402.setMerchantAllowed(agent, merchant, false);
        assertFalse(pay402.isMerchantAllowed(owner, agent, merchant));
        (Pay402.PaymentIntent memory intent, Pay402.Signature memory qs, Pay402.Signature memory isig) =
            _signed(5e6, orderId, validBefore);
        vm.prank(relayer);
        vm.expectRevert(Pay402.MerchantNotAllowed.selector);
        pay402.executePayment(intent, qs, isig);
    }

    function test_updateCaps_changesLimits() public {
        vm.prank(owner);
        pay402.updateCaps(agent, 1e6, 100e6, block.timestamp + 30 days);
        (Pay402.PaymentIntent memory intent, Pay402.Signature memory qs, Pay402.Signature memory isig) =
            _signed(5e6, orderId, validBefore);
        vm.prank(relayer);
        vm.expectRevert(Pay402.ExceedsPerCallCap.selector);
        pay402.executePayment(intent, qs, isig);
    }

    function test_revoke_blocksPayment() public {
        vm.prank(owner);
        pay402.revokeAgent(agent);
        assertEq(pay402.remainingBudget(owner, agent), 0);
        (Pay402.PaymentIntent memory intent, Pay402.Signature memory qs, Pay402.Signature memory isig) =
            _signed(5e6, orderId, validBefore);
        vm.prank(relayer);
        vm.expectRevert(Pay402.AgentIsRevoked.selector);
        pay402.executePayment(intent, qs, isig);
    }

    // ---- happy path ----

    function test_executePayment_happyPath() public {
        vm.expectEmit(true, true, true, true);
        emit Pay402.Paid(orderId, owner, agent, merchant, 5e6);
        _pay(5e6, orderId, validBefore);

        assertEq(token.balanceOf(merchant), 5e6);
        assertEq(token.balanceOf(owner), 995e6);
        assertEq(pay402.allowanceOf(owner, agent).spent, 5e6);
        assertEq(pay402.remainingBudget(owner, agent), 95e6);
        assertTrue(pay402.isOrderPaid(orderId));
    }

    // ---- refusals (the policy checks) ----

    function test_executePayment_revertsOverPerCallCap() public {
        (Pay402.PaymentIntent memory intent, Pay402.Signature memory qs, Pay402.Signature memory isig) =
            _signed(11e6, orderId, validBefore);
        vm.prank(relayer);
        vm.expectRevert(Pay402.ExceedsPerCallCap.selector);
        pay402.executePayment(intent, qs, isig);
    }

    function test_executePayment_revertsOverTotalBudget() public {
        for (uint256 i = 0; i < 10; i++) {
            _pay(10e6, keccak256(abi.encode("fill", i)), validBefore);
        }
        assertEq(pay402.allowanceOf(owner, agent).spent, 100e6);
        (Pay402.PaymentIntent memory intent, Pay402.Signature memory qs, Pay402.Signature memory isig) =
            _signed(1e6, keccak256("one-more"), validBefore);
        vm.prank(relayer);
        vm.expectRevert(Pay402.ExceedsBudget.selector);
        pay402.executePayment(intent, qs, isig);
    }

    function test_executePayment_revertsExpiredAllowance() public {
        vm.warp(block.timestamp + 30 days + 1);
        (Pay402.PaymentIntent memory intent, Pay402.Signature memory qs, Pay402.Signature memory isig) =
            _signed(5e6, orderId, validBefore);
        vm.prank(relayer);
        vm.expectRevert(Pay402.AllowanceExpired.selector);
        pay402.executePayment(intent, qs, isig);
    }

    function test_executePayment_revertsMerchantNotAllowed() public {
        (address other, uint256 otherPk) = makeAddrAndKey("other-merchant");
        (Pay402.PaymentIntent memory intent, Pay402.Signature memory qs, Pay402.Signature memory isig) =
            _signedTo(other, otherPk, 5e6, orderId, validBefore);
        vm.prank(relayer);
        vm.expectRevert(Pay402.MerchantNotAllowed.selector);
        pay402.executePayment(intent, qs, isig);
    }

    function test_executePayment_revertsTamperedQuote() public {
        // Merchant quoted 5e6; the call tries to settle 6e6 against that quote.
        Pay402.Signature memory quoteSig = _signQuote(merchantPk, merchant, orderId, 5e6, validBefore);
        Pay402.Signature memory intentSig =
            _signIntent(agentPk, owner, agent, merchant, 6e6, orderId, validBefore);
        vm.prank(relayer);
        vm.expectRevert(Pay402.InvalidQuote.selector);
        pay402.executePayment(
            Pay402.PaymentIntent(owner, agent, merchant, 6e6, orderId, validBefore), quoteSig, intentSig
        );
    }

    function test_executePayment_revertsWrongAgentIntent() public {
        Pay402.Signature memory quoteSig = _signQuote(merchantPk, merchant, orderId, 5e6, validBefore);
        // Intent signed by the merchant's key, not the agent's.
        Pay402.Signature memory intentSig =
            _signIntent(merchantPk, owner, agent, merchant, 5e6, orderId, validBefore);
        vm.prank(relayer);
        vm.expectRevert(Pay402.InvalidIntent.selector);
        pay402.executePayment(
            Pay402.PaymentIntent(owner, agent, merchant, 5e6, orderId, validBefore), quoteSig, intentSig
        );
    }

    function test_executePayment_revertsReplay() public {
        _pay(5e6, orderId, validBefore);
        (Pay402.PaymentIntent memory intent, Pay402.Signature memory qs, Pay402.Signature memory isig) =
            _signed(5e6, orderId, validBefore);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(Pay402.AlreadyPaid.selector, orderId));
        pay402.executePayment(intent, qs, isig);
    }

    function test_executePayment_revertsExpiredIntent() public {
        uint256 expired = block.timestamp; // validBefore must be in the future
        (Pay402.PaymentIntent memory intent, Pay402.Signature memory qs, Pay402.Signature memory isig) =
            _signed(5e6, orderId, expired);
        vm.prank(relayer);
        vm.expectRevert(Pay402.IntentExpired.selector);
        pay402.executePayment(intent, qs, isig);
    }

    function test_executePayment_revertsWithoutOwnerApproval() public {
        address owner2 = makeAddr("owner2");
        token.mint(owner2, 100e6);
        address[] memory merchants = new address[](1);
        merchants[0] = merchant;
        vm.prank(owner2);
        pay402.createAllowance(agent, merchants, 10e6, 100e6, block.timestamp + 30 days);
        Pay402.Signature memory quoteSig = _signQuote(merchantPk, merchant, orderId, 5e6, validBefore);
        Pay402.Signature memory intentSig = _signIntent(agentPk, owner2, agent, merchant, 5e6, orderId, validBefore);
        vm.prank(relayer);
        vm.expectRevert();
        pay402.executePayment(
            Pay402.PaymentIntent(owner2, agent, merchant, 5e6, orderId, validBefore), quoteSig, intentSig
        );
    }

    function test_executePayment_revertsZeroAmount() public {
        Pay402.Signature memory quoteSig = _signQuote(merchantPk, merchant, orderId, 0, validBefore);
        Pay402.Signature memory intentSig = _signIntent(agentPk, owner, agent, merchant, 0, orderId, validBefore);
        vm.prank(relayer);
        vm.expectRevert(Pay402.ZeroAmount.selector);
        pay402.executePayment(
            Pay402.PaymentIntent(owner, agent, merchant, 0, orderId, validBefore), quoteSig, intentSig
        );
    }

    function testFuzz_executePayment_withinCaps(uint256 amount) public {
        amount = bound(amount, 1, 10e6);
        _pay(amount, keccak256(abi.encode("fuzz", amount)), validBefore);
        assertEq(token.balanceOf(merchant), amount);
    }
}
