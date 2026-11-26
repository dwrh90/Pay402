// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pay402} from "../../src/Pay402.sol";

/// @notice Runs Pay402 against the REAL tUSD8 on a local fork of Aevum testnet.
///         Run with: make test-fork
contract Pay402ForkTest is Test {
    IERC20 constant TUSD8 = IERC20(0x456569838f1d43009A91ebA4263147Afd7233483);

    Pay402 pay402;
    address owner = makeAddr("owner");
    address relayer = makeAddr("relayer");
    address agent;
    uint256 agentPk;
    address merchant;
    uint256 merchantPk;

    function setUp() public {
        (agent, agentPk) = makeAddrAndKey("agent");
        (merchant, merchantPk) = makeAddrAndKey("merchant");
        pay402 = new Pay402(TUSD8);

        deal(address(TUSD8), owner, 100e6);
        vm.prank(owner);
        TUSD8.approve(address(pay402), 100e6);

        address[] memory merchants = new address[](1);
        merchants[0] = merchant;
        vm.prank(owner);
        pay402.createAllowance(agent, merchants, 10e6, 100e6, block.timestamp + 30 days);
    }

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

    function test_fork_pay402_happyPath() public {
        assertEq(block.chainid, 44005, "run with --fork-url aevum");
        bytes32 orderId = keccak256("fork-order");
        uint256 validBefore = block.timestamp + 1 hours;

        Pay402.Signature memory quoteSig = _signQuote(merchantPk, merchant, orderId, 5e6, validBefore);
        Pay402.Signature memory intentSig =
            _signIntent(agentPk, owner, agent, merchant, 5e6, orderId, validBefore);

        vm.prank(relayer);
        pay402.executePayment(
            Pay402.PaymentIntent(owner, agent, merchant, 5e6, orderId, validBefore), quoteSig, intentSig
        );

        assertEq(TUSD8.balanceOf(merchant), 5e6);
        assertEq(TUSD8.balanceOf(owner), 95e6);
        assertEq(pay402.allowanceOf(owner, agent).spent, 5e6);
        assertTrue(pay402.isOrderPaid(orderId));
    }

    function test_fork_pay402_revokeRefuses() public {
        bytes32 orderId = keccak256("fork-order-revoked");
        uint256 validBefore = block.timestamp + 1 hours;

        vm.prank(owner);
        pay402.revokeAgent(agent);

        Pay402.Signature memory quoteSig = _signQuote(merchantPk, merchant, orderId, 5e6, validBefore);
        Pay402.Signature memory intentSig =
            _signIntent(agentPk, owner, agent, merchant, 5e6, orderId, validBefore);

        vm.prank(relayer);
        vm.expectRevert(Pay402.AgentIsRevoked.selector);
        pay402.executePayment(
            Pay402.PaymentIntent(owner, agent, merchant, 5e6, orderId, validBefore), quoteSig, intentSig
        );
        assertEq(TUSD8.balanceOf(merchant), 0);
    }
}
