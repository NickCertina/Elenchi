// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IERC20BalanceReader
 * @notice Minimal read-only ERC-20 interface used solely for optional post-launch fee-waiver checks.
 *         ElenchiArena is NOT a token, launchpad, swap router, or custody contract.
 */
interface IERC20BalanceReader {
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title ECDSALib
 * @notice Strict secp256k1 signature recovery following OpenZeppelin ECDSA malleability bounds (EIP-2).
 */
library ECDSALib {
    error InvalidSignatureLength();
    error InvalidSignatureS();
    error InvalidSignatureV();
    error InvalidSignature();

    uint256 private constant HALF_CURVE_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    function recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) revert InvalidSignatureLength();

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }

        if (uint256(s) > HALF_CURVE_ORDER) revert InvalidSignatureS();
        if (v != 27 && v != 28) revert InvalidSignatureV();

        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }
}

/**
 * @title ElenchiArena
 * @notice Evidence-only EIP-712 verification and attestation registry for Elenchi sandboxed AI agent tests
 *         on Robinhood Chain (chainId 4663 / testnet 46630).
 *
 * @dev TRUST MODEL DISCLOSURE:
 *      1. This contract NEVER executes swaps, moves token allowances, or launches tokens.
 *      2. For signed actions, `ECDSA.recover` proves that `sandboxSigner` signed the non-executable
 *         `SimulatedAction` typed payload under this contract's EIP-712 domain before `deadline`.
 *      3. It does NOT independently prove off-chain LLM reasoning or operator honesty; attestations require
 *         authorization from an explicit `authorizedAttestors` key.
 *      4. `PASSED_SUITE` records outcome for a specific scenario/suite hash and version — never permanent immunity.
 */
contract ElenchiArena {
    using ECDSALib for bytes32;

    // ─────────────────────────────────────────────────────────────────────────────
    // Constants & EIP-712 Typehashes
    // ─────────────────────────────────────────────────────────────────────────────

    string public constant NAME = "ElenchiArena";
    string public constant VERSION = "1";
    uint256 public constant MAX_ATTESTATION_FEE_WEI = 0.01 ether;
    uint16 public constant MAX_BPS = 10_000;

    bytes32 public constant EVIDENCE_NOTICE_HASH =
        keccak256("ELENCHI_EVIDENCE_ONLY_NON_EXECUTABLE_V1");

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 public constant SIMULATED_ACTION_TYPEHASH =
        keccak256(
            "SimulatedAction(bytes32 runId,bytes32 policyHash,bytes32 scenarioHash,uint256 nonce,uint64 deadline,address token,address recipient,uint256 amount,uint16 maxSlippageBps,uint8 actionCategory,bytes32 evidenceNoticeHash)"
        );

    bytes32 public constant ATTESTATION_PERMIT_TYPEHASH =
        keccak256(
            "AttestationPermit(bytes32 runId,bytes32 reportHash,bytes32 policyHash,bytes32 agentConfigHash,bytes32 scenarioHash,bytes32 suiteVersionHash,address sandboxSigner,uint8 outcome,uint8 attackClass,uint8 failureKind,uint8 riskSeverity,uint16 roundsAttempted,uint16 roundsPassed,bool requiresActionSig,bytes32 actionStructHash,uint256 attestorNonce,uint64 deadline)"
        );

    // ─────────────────────────────────────────────────────────────────────────────
    // Enums & Structs
    // ─────────────────────────────────────────────────────────────────────────────

    enum Outcome {
        NONE,          // 0 — uninitialized
        BREACHED,      // 1 — deterministic policy rule violated in sandbox
        PASSED_SUITE,  // 2 — no breach observed within specific tested suite
        INCONCLUSIVE   // 3 — timeout, provider error, or incomplete evaluation
    }

    struct SimulatedAction {
        bytes32 runId;
        bytes32 policyHash;
        bytes32 scenarioHash;
        uint256 nonce;
        uint64 deadline;
        address token;
        address recipient;
        uint256 amount;
        uint16 maxSlippageBps;
        uint8 actionCategory; // 0 = SKIP_TOKEN, 1 = EVIDENCE_ONLY_SIMULATED_SWAP
        bytes32 evidenceNoticeHash;
    }

    struct AttestationInput {
        bytes32 runId;
        bytes32 reportHash;
        bytes32 policyHash;
        bytes32 agentConfigHash;
        bytes32 scenarioHash;
        bytes32 suiteVersionHash;
        address sandboxSigner;
        uint8 outcome;
        uint8 attackClass;
        uint8 failureKind;
        uint8 riskSeverity;
        uint16 roundsAttempted;
        uint16 roundsPassed;
        uint256 attestorNonce;
        uint64 deadline;
    }

    struct AttestationRecord {
        bytes32 reportHash;
        bytes32 policyHash;
        bytes32 agentConfigHash;
        bytes32 scenarioHash;
        bytes32 suiteVersionHash;
        bytes32 actionStructHash;
        address sandboxSigner;
        address attestor;
        address submitter;
        uint64 attestedAt;
        uint16 roundsAttempted;
        uint16 roundsPassed;
        uint8 outcome;
        uint8 attackClass;
        uint8 failureKind;
        uint8 riskSeverity;
        bool hasVerifiedActionSig;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error Unauthorized();
    error ContractPaused();
    error ReentrancyLocked();
    error TokenAlreadyBound();
    error InvalidTokenContract();
    error InvalidLaunchTxHash();
    error FeeExceedsMaxCeiling();
    error InsufficientAttestationFee(uint256 required, uint256 provided);
    error RefundFailed();
    error FeeTransferFailed();
    error RunAlreadyAttested(bytes32 runId);
    error InvalidRunId();
    error InvalidReportHash();
    error InvalidOutcome(uint8 outcome);
    error InvalidAttackClass(uint8 attackClass);
    error InvalidFailureKind(uint8 failureKind);
    error InvalidRiskSeverity(uint8 riskSeverity);
    error InvalidRoundCounts(uint16 attempted, uint16 passed);
    error InvalidSlippageBps(uint16 bps);
    error InvalidActionCategory(uint8 category);
    error InvalidEvidenceNoticeHash(bytes32 provided);
    error ActionContextMismatch();
    error SignatureExpired(uint64 deadline, uint256 currentTimestamp);
    error NonceAlreadyUsed(address signer, uint256 nonce);
    error SandboxSignerMismatch(address expected, address recovered);
    error UnauthorizedAttestor(address recovered);

    // ─────────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────────

    event OwnershipTransferStarted(address indexed previousOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AttestorUpdated(address indexed attestor, bool allowed);
    event PausedStateChanged(bool paused, address indexed triggeredBy);
    event ElenchiTokenBound(address indexed token, bytes32 indexed launchTxHash, address indexed boundBy);
    event FeeConfigUpdated(uint256 attestationFeeWei, address indexed feeRecipient, uint256 feeWaiverThreshold);
    event AttestationRegistered(
        bytes32 indexed runId,
        uint8 indexed outcome,
        uint8 indexed attackClass,
        address sandboxSigner,
        address attestor,
        bytes32 reportHash,
        bool hasVerifiedActionSig
    );

    // ─────────────────────────────────────────────────────────────────────────────
    // Immutable & Mutable State
    // ─────────────────────────────────────────────────────────────────────────────

    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomainSeparator;
    bytes32 private immutable _hashedName;
    bytes32 private immutable _hashedVersion;

    uint256 private _reentrancyLock = 1;

    address public owner;
    address public pendingOwner;
    bool public paused;

    // Optional one-time binding to the owner's manually Pons-launched $ELENCHI ERC-20 token
    address public elenchiToken;
    bytes32 public elenchiTokenLaunchTx;
    bool public tokenBound;

    // Fee settings (optional; default 0 wei)
    uint256 public attestationFeeWei;
    address public feeRecipient;
    uint256 public feeWaiverBalanceThreshold;

    mapping(address => bool) public authorizedAttestors;
    mapping(bytes32 => AttestationRecord) private _attestations;
    mapping(address => mapping(uint256 => bool)) public usedSandboxNonces;
    mapping(address => mapping(uint256 => bool)) public usedAttestorNonces;

    // ─────────────────────────────────────────────────────────────────────────────
    // Constructor & Modifiers
    // ─────────────────────────────────────────────────────────────────────────────

    constructor(
        address initialOwner,
        address initialAttestor,
        address initialFeeRecipient,
        uint256 initialFeeWei,
        address optionalInitialToken
    ) {
        if (initialOwner == address(0) || initialAttestor == address(0) || initialFeeRecipient == address(0)) {
            revert ZeroAddress();
        }
        if (initialFeeWei > MAX_ATTESTATION_FEE_WEI) revert FeeExceedsMaxCeiling();

        owner = initialOwner;
        authorizedAttestors[initialAttestor] = true;
        feeRecipient = initialFeeRecipient;
        attestationFeeWei = initialFeeWei;
        feeWaiverBalanceThreshold = 1_000_000 * 1e18;

        if (optionalInitialToken != address(0)) {
            if (optionalInitialToken.code.length == 0) revert InvalidTokenContract();
            elenchiToken = optionalInitialToken;
            tokenBound = true;
        }

        _hashedName = keccak256(bytes(NAME));
        _hashedVersion = keccak256(bytes(VERSION));
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();

        emit OwnershipTransferred(address(0), initialOwner);
        emit AttestorUpdated(initialAttestor, true);
        emit FeeConfigUpdated(initialFeeWei, initialFeeRecipient, feeWaiverBalanceThreshold);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyLock == 2) revert ReentrancyLocked();
        _reentrancyLock = 2;
        _;
        _reentrancyLock = 1;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // EIP-712 Domain & Digest Views
    // ─────────────────────────────────────────────────────────────────────────────

    function domainSeparator() public view returns (bytes32) {
        if (block.chainid == _cachedChainId) {
            return _cachedDomainSeparator;
        }
        return _buildDomainSeparator();
    }

    function hashSimulatedAction(SimulatedAction calldata action) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SIMULATED_ACTION_TYPEHASH,
                action.runId,
                action.policyHash,
                action.scenarioHash,
                action.nonce,
                action.deadline,
                action.token,
                action.recipient,
                action.amount,
                action.maxSlippageBps,
                action.actionCategory,
                action.evidenceNoticeHash
            )
        );
    }

    function hashTypedSimulatedAction(SimulatedAction calldata action) public view returns (bytes32) {
        return _hashTypedDataV4(hashSimulatedAction(action));
    }

    function verifySimulatedActionSignature(
        SimulatedAction calldata action,
        bytes calldata signature
    ) external view returns (address recoveredSigner, bytes32 digest) {
        if (action.evidenceNoticeHash != EVIDENCE_NOTICE_HASH) {
            revert InvalidEvidenceNoticeHash(action.evidenceNoticeHash);
        }
        digest = hashTypedSimulatedAction(action);
        recoveredSigner = digest.recover(signature);
    }

    function hashAttestationPermit(
        AttestationInput calldata input,
        bool requiresActionSig,
        bytes32 actionStructHash
    ) public pure returns (bytes32) {
        bytes memory head = abi.encode(
            ATTESTATION_PERMIT_TYPEHASH,
            input.runId,
            input.reportHash,
            input.policyHash,
            input.agentConfigHash,
            input.scenarioHash,
            input.suiteVersionHash,
            input.sandboxSigner,
            input.outcome
        );
        bytes memory tail = abi.encode(
            input.attackClass,
            input.failureKind,
            input.riskSeverity,
            input.roundsAttempted,
            input.roundsPassed,
            requiresActionSig,
            actionStructHash,
            input.attestorNonce,
            input.deadline
        );
        return keccak256(bytes.concat(head, tail));
    }

    function hashTypedAttestationPermit(
        AttestationInput calldata input,
        bool requiresActionSig,
        bytes32 actionStructHash
    ) public view returns (bytes32) {
        return _hashTypedDataV4(hashAttestationPermit(input, requiresActionSig, actionStructHash));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Core Attestation Registration
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Registers an evidence-backed evaluation outcome on-chain.
     * @param input Compact run metadata hashes and outcome parameters (no private prompts).
     * @param hasAction Whether a sandbox EIP-712 `SimulatedAction` packet is included.
     * @param action Non-executable `SimulatedAction` struct (ignored when `hasAction == false`).
     * @param actionSignature 65-byte ECDSA signature by `input.sandboxSigner` over `action`.
     * @param attestorPermitSignature 65-byte ECDSA signature by an authorized attestor (empty if `msg.sender` is an authorized attestor).
     */
    function registerAttestation(
        AttestationInput calldata input,
        bool hasAction,
        SimulatedAction calldata action,
        bytes calldata actionSignature,
        bytes calldata attestorPermitSignature
    ) external payable whenNotPaused nonReentrant {
        _validateAttestationInput(input);

        if (_attestations[input.runId].outcome != uint8(Outcome.NONE)) {
            revert RunAlreadyAttested(input.runId);
        }

        bytes32 actionStructHash = bytes32(0);
        if (hasAction) {
            actionStructHash = _verifyAndConsumeSimulatedAction(input, action, actionSignature);
        }

        address resolvedAttestor = _resolveAndConsumeAttestor(
            input,
            hasAction,
            actionStructHash,
            attestorPermitSignature
        );

        _collectFeeAndRefundExcess(msg.sender);

        _storeAndEmitAttestation(input, actionStructHash, resolvedAttestor, hasAction);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Read Views
    // ─────────────────────────────────────────────────────────────────────────────

    function getAttestation(bytes32 runId) external view returns (AttestationRecord memory) {
        return _attestations[runId];
    }

    function isRunAttested(bytes32 runId) external view returns (bool) {
        return _attestations[runId].outcome != uint8(Outcome.NONE);
    }

    function requiredFeeFor(address account) public view returns (uint256) {
        uint256 baseFee = attestationFeeWei;
        if (baseFee == 0) return 0;
        if (elenchiToken != address(0) && feeWaiverBalanceThreshold > 0) {
            (bool ok, bytes memory data) = elenchiToken.staticcall(
                abi.encodeWithSelector(IERC20BalanceReader.balanceOf.selector, account)
            );
            if (ok && data.length >= 32) {
                uint256 bal = abi.decode(data, (uint256));
                if (bal >= feeWaiverBalanceThreshold) {
                    return 0;
                }
            }
        }
        return baseFee;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Governance & One-Time Manual Pons Token Binding
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @notice One-time binding of the externally Pons-launched $ELENCHI ERC-20 contract.
     *         Irreversible once set; cannot mint, upgrade, or modify the token.
     */
    function bindElenchiTokenOnce(address token, bytes32 launchTxHash) external onlyOwner {
        if (tokenBound) revert TokenAlreadyBound();
        if (token == address(0)) revert ZeroAddress();
        if (token.code.length == 0) revert InvalidTokenContract();
        if (launchTxHash == bytes32(0)) revert InvalidLaunchTxHash();

        elenchiToken = token;
        elenchiTokenLaunchTx = launchTxHash;
        tokenBound = true;

        emit ElenchiTokenBound(token, launchTxHash, msg.sender);
    }

    function setAttestor(address attestor, bool allowed) external onlyOwner {
        if (attestor == address(0)) revert ZeroAddress();
        authorizedAttestors[attestor] = allowed;
        emit AttestorUpdated(attestor, allowed);
    }

    function setFeeConfig(
        uint256 newFeeWei,
        address newFeeRecipient,
        uint256 newWaiverThreshold
    ) external onlyOwner {
        if (newFeeRecipient == address(0)) revert ZeroAddress();
        if (newFeeWei > MAX_ATTESTATION_FEE_WEI) revert FeeExceedsMaxCeiling();

        attestationFeeWei = newFeeWei;
        feeRecipient = newFeeRecipient;
        feeWaiverBalanceThreshold = newWaiverThreshold;

        emit FeeConfigUpdated(newFeeWei, newFeeRecipient, newWaiverThreshold);
    }

    function setPaused(bool shouldPause) external onlyOwner {
        paused = shouldPause;
        emit PausedStateChanged(shouldPause, msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        address prev = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(prev, owner);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Internal Verification Helpers
    // ─────────────────────────────────────────────────────────────────────────────

    function _validateAttestationInput(AttestationInput calldata input) internal view {
        if (input.runId == bytes32(0)) revert InvalidRunId();
        if (input.reportHash == bytes32(0)) revert InvalidReportHash();
        if (input.sandboxSigner == address(0)) revert ZeroAddress();
        if (input.outcome < uint8(Outcome.BREACHED) || input.outcome > uint8(Outcome.INCONCLUSIVE)) {
            revert InvalidOutcome(input.outcome);
        }
        if (input.attackClass > 5) revert InvalidAttackClass(input.attackClass);
        if (input.failureKind > 6) revert InvalidFailureKind(input.failureKind);
        if (input.riskSeverity > 4) revert InvalidRiskSeverity(input.riskSeverity);
        if (input.roundsAttempted == 0 || input.roundsPassed > input.roundsAttempted) {
            revert InvalidRoundCounts(input.roundsAttempted, input.roundsPassed);
        }
        if (block.timestamp > input.deadline) {
            revert SignatureExpired(input.deadline, block.timestamp);
        }
    }

    function _verifyAndConsumeSimulatedAction(
        AttestationInput calldata input,
        SimulatedAction calldata action,
        bytes calldata actionSignature
    ) internal returns (bytes32 structHash) {
        if (
            action.runId != input.runId ||
            action.policyHash != input.policyHash ||
            action.scenarioHash != input.scenarioHash
        ) {
            revert ActionContextMismatch();
        }
        if (block.timestamp > action.deadline) {
            revert SignatureExpired(action.deadline, block.timestamp);
        }
        if (action.maxSlippageBps > MAX_BPS) {
            revert InvalidSlippageBps(action.maxSlippageBps);
        }
        if (action.actionCategory > 1) {
            revert InvalidActionCategory(action.actionCategory);
        }
        if (action.evidenceNoticeHash != EVIDENCE_NOTICE_HASH) {
            revert InvalidEvidenceNoticeHash(action.evidenceNoticeHash);
        }
        if (usedSandboxNonces[input.sandboxSigner][action.nonce]) {
            revert NonceAlreadyUsed(input.sandboxSigner, action.nonce);
        }

        structHash = hashSimulatedAction(action);
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = digest.recover(actionSignature);
        if (recovered != input.sandboxSigner) {
            revert SandboxSignerMismatch(input.sandboxSigner, recovered);
        }

        usedSandboxNonces[input.sandboxSigner][action.nonce] = true;
    }

    function _resolveAndConsumeAttestor(
        AttestationInput calldata input,
        bool hasAction,
        bytes32 actionStructHash,
        bytes calldata attestorPermitSignature
    ) internal returns (address attestor) {
        if (authorizedAttestors[msg.sender] && attestorPermitSignature.length == 0) {
            if (usedAttestorNonces[msg.sender][input.attestorNonce]) {
                revert NonceAlreadyUsed(msg.sender, input.attestorNonce);
            }
            usedAttestorNonces[msg.sender][input.attestorNonce] = true;
            return msg.sender;
        }

        bytes32 permitDigest = hashTypedAttestationPermit(input, hasAction, actionStructHash);
        attestor = permitDigest.recover(attestorPermitSignature);
        if (!authorizedAttestors[attestor]) {
            revert UnauthorizedAttestor(attestor);
        }
        if (usedAttestorNonces[attestor][input.attestorNonce]) {
            revert NonceAlreadyUsed(attestor, input.attestorNonce);
        }
        usedAttestorNonces[attestor][input.attestorNonce] = true;
    }

    function _collectFeeAndRefundExcess(address payer) internal {
        uint256 requiredFee = requiredFeeFor(payer);
        if (msg.value < requiredFee) {
            revert InsufficientAttestationFee(requiredFee, msg.value);
        }

        if (requiredFee > 0) {
            (bool sentFee, ) = feeRecipient.call{value: requiredFee}("");
            if (!sentFee) revert FeeTransferFailed();
        }

        uint256 excess = msg.value - requiredFee;
        if (excess > 0) {
            (bool refunded, ) = payer.call{value: excess}("");
            if (!refunded) revert RefundFailed();
        }
    }

    function _storeAndEmitAttestation(
        AttestationInput calldata input,
        bytes32 actionStructHash,
        address resolvedAttestor,
        bool hasAction
    ) internal {
        AttestationRecord storage rec = _attestations[input.runId];
        rec.reportHash = input.reportHash;
        rec.policyHash = input.policyHash;
        rec.agentConfigHash = input.agentConfigHash;
        rec.scenarioHash = input.scenarioHash;
        rec.suiteVersionHash = input.suiteVersionHash;
        rec.actionStructHash = actionStructHash;
        rec.sandboxSigner = input.sandboxSigner;
        rec.attestor = resolvedAttestor;
        rec.submitter = msg.sender;
        rec.attestedAt = uint64(block.timestamp);
        rec.roundsAttempted = input.roundsAttempted;
        rec.roundsPassed = input.roundsPassed;
        rec.outcome = input.outcome;
        rec.attackClass = input.attackClass;
        rec.failureKind = input.failureKind;
        rec.riskSeverity = input.riskSeverity;
        rec.hasVerifiedActionSig = hasAction;

        emit AttestationRegistered(
            input.runId,
            input.outcome,
            input.attackClass,
            input.sandboxSigner,
            resolvedAttestor,
            input.reportHash,
            hasAction
        );
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                _hashedName,
                _hashedVersion,
                block.chainid,
                address(this)
            )
        );
    }

    function _hashTypedDataV4(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }
}
