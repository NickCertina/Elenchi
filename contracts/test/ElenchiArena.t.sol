// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ElenchiArena} from "../src/ElenchiArena.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address caller) external;
    function deal(address who, uint256 newBalance) external;
    function warp(uint256 newTimestamp) external;
    function expectRevert(bytes calldata revertData) external;
    function expectRevert(bytes4 revertSelector) external;
}

contract MockERC20ForWaiver {
    mapping(address => uint256) public balanceOf;

    function setBalance(address who, uint256 amount) external {
        balanceOf[who] = amount;
    }
}

/**
 * @title ElenchiArenaFoundryTest
 * @notice Foundry test suite (unit + fuzz) for `ElenchiArena.sol`.
 */
contract ElenchiArenaTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant OWNER_PK = 0xA11CE;
    uint256 internal constant ATTESTOR_PK = 0xB0B;
    uint256 internal constant SANDBOX_PK = 0xCAFE;
    uint256 internal constant USER_PK = 0xD00D;

    address internal ownerAddr;
    address internal attestorAddr;
    address internal sandboxAddr;
    address internal userAddr;
    address internal feeTreasury = address(0xFEE001);

    ElenchiArena internal arena;
    MockERC20ForWaiver internal mockToken;

    function setUp() public {
        ownerAddr = vm.addr(OWNER_PK);
        attestorAddr = vm.addr(ATTESTOR_PK);
        sandboxAddr = vm.addr(SANDBOX_PK);
        userAddr = vm.addr(USER_PK);

        vm.warp(1_795_000_000);
        mockToken = new MockERC20ForWaiver();
        arena = new ElenchiArena(ownerAddr, attestorAddr, feeTreasury, 0.0005 ether, address(0));
    }

    function testRegisterBreachedWithSignedAction() public {
        bytes32 runId = keccak256("run-breach-01");
        bytes32 policyHash = keccak256("policy-momentum");
        bytes32 scenarioHash = keccak256("scenario-slippage-override");

        ElenchiArena.SimulatedAction memory action = ElenchiArena.SimulatedAction({
            runId: runId,
            policyHash: policyHash,
            scenarioHash: scenarioHash,
            nonce: 1,
            deadline: uint64(block.timestamp + 600),
            token: address(0x1111111111111111111111111111111111111111),
            recipient: address(0x2222222222222222222222222222222222222222),
            amount: 1 ether,
            maxSlippageBps: 2500,
            actionCategory: 1,
            evidenceNoticeHash: arena.EVIDENCE_NOTICE_HASH()
        });

        bytes memory actionSig = _signDigest(SANDBOX_PK, arena.hashTypedSimulatedAction(action));

        ElenchiArena.AttestationInput memory input = ElenchiArena.AttestationInput({
            runId: runId,
            reportHash: keccak256("report-01"),
            policyHash: policyHash,
            agentConfigHash: keccak256("cfg-01"),
            scenarioHash: scenarioHash,
            suiteVersionHash: keccak256("suite-v1"),
            sandboxSigner: sandboxAddr,
            outcome: uint8(ElenchiArena.Outcome.BREACHED),
            attackClass: 4,
            failureKind: 1,
            riskSeverity: 4,
            roundsAttempted: 2,
            roundsPassed: 1,
            attestorNonce: 100,
            deadline: uint64(block.timestamp + 600)
        });

        bytes32 structHash = arena.hashSimulatedAction(action);
        bytes memory permitSig = _signDigest(
            ATTESTOR_PK,
            arena.hashTypedAttestationPermit(input, true, structHash)
        );

        vm.deal(userAddr, 1 ether);
        vm.prank(userAddr);
        arena.registerAttestation{value: 0.0005 ether}(input, true, action, actionSig, permitSig);

        assert(arena.isRunAttested(runId));
        ElenchiArena.AttestationRecord memory rec = arena.getAttestation(runId);
        assert(rec.outcome == uint8(ElenchiArena.Outcome.BREACHED));
        assert(rec.hasVerifiedActionSig);
        assert(rec.sandboxSigner == sandboxAddr);
        assert(rec.attestor == attestorAddr);
    }

    function testOneTimeTokenBindingAndFeeWaiver() public {
        vm.prank(ownerAddr);
        arena.bindElenchiTokenOnce(address(mockToken), keccak256("pons-launch-tx"));
        assert(arena.tokenBound());

        vm.prank(ownerAddr);
        vm.expectRevert(ElenchiArena.TokenAlreadyBound.selector);
        arena.bindElenchiTokenOnce(address(mockToken), keccak256("pons-launch-tx-2"));

        mockToken.setBalance(userAddr, 1_000_000 * 1e18);
        assert(arena.requiredFeeFor(userAddr) == 0);
    }

    function testFuzzRejectInvalidSlippage(uint16 badBps) public {
        if (badBps <= 10_000) return;
        bytes32 runId = keccak256(abi.encodePacked("fuzz-slip", badBps));
        ElenchiArena.SimulatedAction memory action = ElenchiArena.SimulatedAction({
            runId: runId,
            policyHash: keccak256("p"),
            scenarioHash: keccak256("s"),
            nonce: uint256(badBps),
            deadline: uint64(block.timestamp + 300),
            token: address(0x1111),
            recipient: address(0x2222),
            amount: 100,
            maxSlippageBps: badBps,
            actionCategory: 1,
            evidenceNoticeHash: arena.EVIDENCE_NOTICE_HASH()
        });
        bytes memory actionSig = _signDigest(SANDBOX_PK, arena.hashTypedSimulatedAction(action));
        ElenchiArena.AttestationInput memory input = ElenchiArena.AttestationInput({
            runId: runId,
            reportHash: keccak256("r"),
            policyHash: keccak256("p"),
            agentConfigHash: keccak256("c"),
            scenarioHash: keccak256("s"),
            suiteVersionHash: keccak256("v1"),
            sandboxSigner: sandboxAddr,
            outcome: uint8(ElenchiArena.Outcome.BREACHED),
            attackClass: 4,
            failureKind: 1,
            riskSeverity: 3,
            roundsAttempted: 1,
            roundsPassed: 0,
            attestorNonce: uint256(badBps),
            deadline: uint64(block.timestamp + 300)
        });
        vm.deal(attestorAddr, 1 ether);
        vm.prank(attestorAddr);
        vm.expectRevert(abi.encodeWithSelector(ElenchiArena.InvalidSlippageBps.selector, badBps));
        arena.registerAttestation{value: 0.0005 ether}(input, true, action, actionSig, "");
    }

    function _signDigest(uint256 pk, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
