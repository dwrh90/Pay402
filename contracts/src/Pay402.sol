// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Pay402
/// @notice x402-style pay-per-request for AI agents, with an on-chain allowance as the policy engine.
///
/// How it works:
///  1. The OWNER creates an allowance for an AGENT: which merchants it may pay, a per-call price
///     cap, a total budget cap, and an expiry. The owner can change the caps or revoke instantly.
///  2. A MERCHANT offers a service at a price. It signs a Quote (merchant, orderId, amount,
///     validBefore) so the agent can verify the price is genuine before paying.
///  3. The AGENT checks the quote against its policy. If anything fails (merchant not allowlisted,
///     price above the per-call cap, budget blown, expired) the agent REFUSES and never signs.
///  4. If all checks pass, the agent signs a PaymentIntent and a RELAYER submits it.
///     The contract re-checks everything on chain, then pulls the tokens from the OWNER's wallet
///     (the owner approved this contract once, up to the budget) and pays the merchant.
///
/// The agent's key can never move funds by itself: it can only request payments, and the contract
/// enforces the policy. Steal the agent key and the worst you can do is pay allowlisted merchants
/// within the caps, until the owner revokes. Funds never sit in this contract's custody.
contract Pay402 is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The policy an owner sets for one agent.
    struct Allowance {
        address agent;
        uint256 perCallCap;
        uint256 totalBudget;
        uint256 spent;
        uint256 expiresAt;
        bool revoked;
    }

    /// @notice A merchant's signed price for one order. The agent verifies this before paying.
    struct Quote {
        address merchant;
        bytes32 orderId;
        uint256 amount;
        uint256 validBefore;
    }

    /// @notice The agent's signed request to pay one order. Only the registered agent may sign it.
    ///         It doubles as the payment request passed to executePayment.
    struct PaymentIntent {
        address owner;
        address agent;
        address merchant;
        uint256 amount;
        bytes32 orderId;
        uint256 validBefore;
    }

    /// @notice An ECDSA signature (v, r, s) for a quote or an intent.
    struct Signature {
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(address merchant,bytes32 orderId,uint256 amount,uint256 validBefore)"
    );
    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "PaymentIntent(address owner,address agent,address merchant,uint256 amount,bytes32 orderId,uint256 validBefore)"
    );

    IERC20 public immutable token;

    mapping(address owner => mapping(address agent => Allowance)) private _allowances;
    mapping(address owner => mapping(address agent => mapping(address merchant => bool))) private
        _merchantAllowed;
    mapping(bytes32 orderId => bool) private _paidOrders;

    event AllowanceSet(
        address indexed owner, address indexed agent, uint256 perCallCap, uint256 totalBudget, uint256 expiresAt
    );
    event MerchantAllowed(address indexed owner, address indexed agent, address indexed merchant, bool allowed);
    event AgentRevoked(address indexed owner, address indexed agent);
    event Paid(
        bytes32 indexed orderId,
        address indexed owner,
        address indexed agent,
        address merchant,
        uint256 amount
    );

    error ZeroAmount();
    error ZeroAddress();
    error AllowanceExpired();
    error AgentNotConfigured();
    error AgentIsRevoked();
    error MerchantNotAllowed();
    error ExceedsPerCallCap();
    error ExceedsBudget();
    error IntentExpired();
    error InvalidQuote();
    error InvalidIntent();
    error AlreadyPaid(bytes32 orderId);

    constructor(IERC20 token_) EIP712("Pay402", "1") {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    /// @notice Create (or replace) the allowance `msg.sender` grants to `agent`.
    /// @dev Re-creating keeps the amount already spent, so the budget can never be reset by
    ///      re-issuing. `merchants` are ADDED to the allowlist; use setMerchantAllowed to remove one.
    function createAllowance(
        address agent,
        address[] calldata merchants,
        uint256 perCallCap,
        uint256 totalBudget,
        uint256 expiresAt
    ) external {
        if (agent == address(0)) revert ZeroAddress();
        if (perCallCap == 0 || totalBudget == 0) revert ZeroAmount();
        if (expiresAt <= block.timestamp) revert AllowanceExpired();

        Allowance storage a = _allowances[msg.sender][agent];
        uint256 spent = a.agent == address(0) ? 0 : a.spent;
        _allowances[msg.sender][agent] = Allowance({
            agent: agent,
            perCallCap: perCallCap,
            totalBudget: totalBudget,
            spent: spent,
            expiresAt: expiresAt,
            revoked: false
        });
        for (uint256 i = 0; i < merchants.length; i++) {
            if (merchants[i] == address(0)) revert ZeroAddress();
            _merchantAllowed[msg.sender][agent][merchants[i]] = true;
            emit MerchantAllowed(msg.sender, agent, merchants[i], true);
        }
        emit AllowanceSet(msg.sender, agent, perCallCap, totalBudget, expiresAt);
    }

    /// @notice Allow or block one merchant for one agent.
    function setMerchantAllowed(address agent, address merchant, bool allowed) external {
        if (_allowances[msg.sender][agent].agent == address(0)) revert AgentNotConfigured();
        if (merchant == address(0)) revert ZeroAddress();
        _merchantAllowed[msg.sender][agent][merchant] = allowed;
        emit MerchantAllowed(msg.sender, agent, merchant, allowed);
    }

    /// @notice Change the caps / expiry for one agent. Spent is preserved.
    function updateCaps(address agent, uint256 perCallCap, uint256 totalBudget, uint256 expiresAt) external {
        Allowance storage a = _allowances[msg.sender][agent];
        if (a.agent == address(0)) revert AgentNotConfigured();
        if (perCallCap == 0 || totalBudget == 0) revert ZeroAmount();
        if (expiresAt <= block.timestamp) revert AllowanceExpired();
        a.perCallCap = perCallCap;
        a.totalBudget = totalBudget;
        a.expiresAt = expiresAt;
        emit AllowanceSet(msg.sender, agent, perCallCap, totalBudget, expiresAt);
    }

    /// @notice Revoke an agent instantly. In-flight intents fail from this block on.
    function revokeAgent(address agent) external {
        Allowance storage a = _allowances[msg.sender][agent];
        if (a.agent == address(0)) revert AgentNotConfigured();
        a.revoked = true;
        emit AgentRevoked(msg.sender, agent);
    }

    /// @notice Settle one agent payment. Callable by anyone (a relayer pays the gas).
    /// @dev Verifies the merchant's quote AND the agent's intent, checks the on-chain policy,
    ///      records the payment, then pulls tokens from the owner and pays the merchant.
    ///      The intent is passed as one struct so the call stays within the EVM stack limit.
    function executePayment(PaymentIntent calldata intent, Signature calldata quoteSig, Signature calldata intentSig)
        external
        nonReentrant
    {
        if (intent.amount == 0) revert ZeroAmount();
        if (_paidOrders[intent.orderId]) revert AlreadyPaid(intent.orderId);

        Allowance storage a = _allowances[intent.owner][intent.agent];
        if (a.agent == address(0)) revert AgentNotConfigured();
        if (a.revoked) revert AgentIsRevoked();
        if (block.timestamp > a.expiresAt) revert AllowanceExpired();
        if (block.timestamp >= intent.validBefore) revert IntentExpired();
        if (!_merchantAllowed[intent.owner][intent.agent][intent.merchant]) revert MerchantNotAllowed();
        if (intent.amount > a.perCallCap) revert ExceedsPerCallCap();
        if (a.spent + intent.amount > a.totalBudget) revert ExceedsBudget();

        bytes32 quoteDigest = _hashTypedDataV4(
            keccak256(
                abi.encode(QUOTE_TYPEHASH, intent.merchant, intent.orderId, intent.amount, intent.validBefore)
            )
        );
        if (ECDSA.recover(quoteDigest, quoteSig.v, quoteSig.r, quoteSig.s) != intent.merchant) {
            revert InvalidQuote();
        }

        bytes32 intentDigest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    INTENT_TYPEHASH,
                    intent.owner,
                    intent.agent,
                    intent.merchant,
                    intent.amount,
                    intent.orderId,
                    intent.validBefore
                )
            )
        );
        if (ECDSA.recover(intentDigest, intentSig.v, intentSig.r, intentSig.s) != intent.agent) {
            revert InvalidIntent();
        }

        _paidOrders[intent.orderId] = true;
        a.spent += intent.amount;
        emit Paid(intent.orderId, intent.owner, intent.agent, intent.merchant, intent.amount);

        token.safeTransferFrom(intent.owner, intent.merchant, intent.amount);
    }

    /// @notice The EIP-712 domain separator, for agents and merchants signing quotes and intents.
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function allowanceOf(address owner, address agent) external view returns (Allowance memory) {
        return _allowances[owner][agent];
    }

    function isMerchantAllowed(address owner, address agent, address merchant) external view returns (bool) {
        return _merchantAllowed[owner][agent][merchant];
    }

    function isOrderPaid(bytes32 orderId) external view returns (bool) {
        return _paidOrders[orderId];
    }

    function remainingBudget(address owner, address agent) external view returns (uint256) {
        Allowance storage a = _allowances[owner][agent];
        if (a.agent == address(0) || a.revoked) return 0;
        if (a.spent >= a.totalBudget) return 0;
        return a.totalBudget - a.spent;
    }
}
