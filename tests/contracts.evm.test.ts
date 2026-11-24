import fs from "node:fs";
import path from "node:path";
import solc from "solc";
import { describe, expect, it } from "vitest";
import { createVM, runTx } from "@ethereumjs/vm";
import { createCustomCommon, Hardfork, Mainnet } from "@ethereumjs/common";
import { createLegacyTx } from "@ethereumjs/tx";
import {
  Account,
  Address,
  bytesToHex,
  hexToBytes,
  privateToAddress,
} from "@ethereumjs/util";
import {
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createIsolatedSandboxSigner,
  EVIDENCE_NOTICE_HASH,
  hashTextArtifact,
  runIdToBytes32,
  signAttestationPermit,
} from "@elenchi/eip712";

const ARENA_ABI = parseAbi([
  "constructor(address initialOwner, address initialAttestor, address initialFeeRecipient, uint256 initialFeeWei, address optionalInitialToken)",
  "function domainSeparator() view returns (bytes32)",
  "function EVIDENCE_NOTICE_HASH() view returns (bytes32)",
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function tokenBound() view returns (bool)",
  "function elenchiToken() view returns (address)",
  "function requiredFeeFor(address account) view returns (uint256)",
  "function isRunAttested(bytes32 runId) view returns (bool)",
  "function verifySimulatedActionSignature((bytes32 runId,bytes32 policyHash,bytes32 scenarioHash,uint256 nonce,uint64 deadline,address token,address recipient,uint256 amount,uint16 maxSlippageBps,uint8 actionCategory,bytes32 evidenceNoticeHash) action, bytes signature) view returns (address recoveredSigner, bytes32 digest)",
  "function registerAttestation((bytes32 runId,bytes32 reportHash,bytes32 policyHash,bytes32 agentConfigHash,bytes32 scenarioHash,bytes32 suiteVersionHash,address sandboxSigner,uint8 outcome,uint8 attackClass,uint8 failureKind,uint8 riskSeverity,uint16 roundsAttempted,uint16 roundsPassed,uint256 attestorNonce,uint64 deadline) input, bool hasAction, (bytes32 runId,bytes32 policyHash,bytes32 scenarioHash,uint256 nonce,uint64 deadline,address token,address recipient,uint256 amount,uint16 maxSlippageBps,uint8 actionCategory,bytes32 evidenceNoticeHash) action, bytes actionSignature, bytes attestorPermitSignature) payable",
  "function getAttestation(bytes32 runId) view returns ((bytes32 reportHash,bytes32 policyHash,bytes32 agentConfigHash,bytes32 scenarioHash,bytes32 suiteVersionHash,bytes32 actionStructHash,address sandboxSigner,address attestor,address submitter,uint64 attestedAt,uint16 roundsAttempted,uint16 roundsPassed,uint8 outcome,uint8 attackClass,uint8 failureKind,uint8 riskSeverity,bool hasVerifiedActionSig))",
  "function bindElenchiTokenOnce(address token, bytes32 launchTxHash)",
  "function setPaused(bool shouldPause)",
  "function setAttestor(address attestor, bool allowed)",
  "function setFeeConfig(uint256 newFeeWei, address newFeeRecipient, uint256 newWaiverThreshold)",
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
]);

const MOCK_TOKEN_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract MockPonsToken {
    mapping(address => uint256) public balanceOf;
    function setBalance(address who, uint256 v) external { balanceOf[who] = v; }
}`;

const MOCK_TOKEN_ABI = parseAbi([
  "function setBalance(address who, uint256 v)",
  "function balanceOf(address who) view returns (uint256)",
]);

function compileContracts() {
  const arenaSource = fs.readFileSync(
    path.join(process.cwd(), "contracts", "src", "ElenchiArena.sol"),
    "utf-8"
  );
  const input = {
    language: "Solidity",
    sources: {
      "ElenchiArena.sol": { content: arenaSource },
      "MockPonsToken.sol": { content: MOCK_TOKEN_SOURCE },
    },
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (output.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errs.length > 0) {
    throw new Error(errs.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  }
  return {
    arenaBytecode: `0x${output.contracts["ElenchiArena.sol"].ElenchiArena.evm.bytecode.object}` as `0x${string}`,
    mockTokenBytecode: `0x${output.contracts["MockPonsToken.sol"].MockPonsToken.evm.bytecode.object}` as `0x${string}`,
  };
}

const compiled = compileContracts();

const OWNER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const ATTESTOR_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
const USER_PK = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as const;
const ROGUE_PK = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" as const;
const TREASURY_ADDR = "0x0000000000000000000000000000000000fee999" as const;

async function setupRobinhoodVm(chainId = 4663, feeWei = 500_000_000_000_000n) {
  const common = createCustomCommon(
    { chainId },
    Mainnet,
    { hardfork: Hardfork.Cancun }
  );
  const vm = await createVM({ common });
  const nonces = new Map<string, bigint>();

  for (const pk of [OWNER_PK, ATTESTOR_PK, USER_PK, ROGUE_PK]) {
    const addr = new Address(privateToAddress(hexToBytes(pk)));
    await vm.stateManager.putAccount(addr, new Account(0n, 50n * 10n ** 18n));
    nonces.set(addr.toString(), 0n);
  }
  await vm.stateManager.putAccount(
    new Address(hexToBytes(TREASURY_ADDR)),
    new Account(0n, 0n)
  );

  async function sendTx(pk: `0x${string}`, to: `0x${string}` | undefined, data: `0x${string}`, value = 0n, timestamp = 1_800_000_000n) {
    const senderAddr = new Address(privateToAddress(hexToBytes(pk))).toString();
    const nonce = nonces.get(senderAddr) ?? 0n;
    nonces.set(senderAddr, nonce + 1n);

    const tx = createLegacyTx(
      {
        nonce,
        gasPrice: 1_000_000_000n,
        gasLimit: 5_000_000n,
        to: to ? new Address(hexToBytes(to)) : undefined,
        value,
        data: hexToBytes(data),
      },
      { common }
    ).sign(hexToBytes(pk));

    const res = await runTx(vm, {
      tx,
      skipBlockGasLimitValidation: true,
      block: {
        common,
        header: {
          number: 1n,
          timestamp,
          gasLimit: 30_000_000n,
          coinbase: new Address(hexToBytes("0x0000000000000000000000000000000000000000")),
          baseFeePerGas: 0n,
          prevRandao: new Uint8Array(32),
          excessBlobGas: 0n,
          cliqueSigner: () => new Address(hexToBytes("0x0000000000000000000000000000000000000000")),
        },
      } as never,
    });
    return res;
  }

  async function callView<T>(to: `0x${string}`, functionName: string, args: readonly unknown[] = []): Promise<T> {
    const data = encodeFunctionData({ abi: ARENA_ABI, functionName: functionName as never, args: args as never });
    const res = await vm.evm.runCall({
      to: new Address(hexToBytes(to)),
      data: hexToBytes(data),
    });
    if (res.execResult.exceptionError) {
      throw new Error(`View reverted: ${res.execResult.exceptionError.error}`);
    }
    return decodeFunctionResult({
      abi: ARENA_ABI,
      functionName: functionName as never,
      data: bytesToHex(res.execResult.returnValue),
    }) as T;
  }

  const ownerAddr = privateKeyToAccount(OWNER_PK).address;
  const attestorAddr = privateKeyToAccount(ATTESTOR_PK).address;
  const userAddr = privateKeyToAccount(USER_PK).address;

  const deployData = encodeDeployData({
    abi: ARENA_ABI,
    bytecode: compiled.arenaBytecode,
    args: [ownerAddr, attestorAddr, TREASURY_ADDR, feeWei, "0x0000000000000000000000000000000000000000"],
  });
  const deployRes = await sendTx(OWNER_PK, undefined, deployData);
  if (deployRes.execResult.exceptionError || !deployRes.createdAddress) {
    throw new Error("Failed to deploy ElenchiArena");
  }
  const arenaAddress = bytesToHex(deployRes.createdAddress.bytes) as `0x${string}`;

  const tokenDeployRes = await sendTx(OWNER_PK, undefined, compiled.mockTokenBytecode);
  const mockTokenAddress = bytesToHex(tokenDeployRes.createdAddress!.bytes) as `0x${string}`;

  return { vm, sendTx, callView, arenaAddress, mockTokenAddress, ownerAddr, attestorAddr, userAddr };
}

describe("ElenchiArena.sol EVM Verification Suite (Chain 4663 & 46630)", () => {
  it("recovers EIP-712 SimulatedAction signature identically in TypeScript and Solidity and registers BREACHED", async () => {
    const ctx = await setupRobinhoodVm(4663);
    const sandboxSigner = createIsolatedSandboxSigner();
    const runId = runIdToBytes32("breach-run-001");
    const policyHash = hashTextArtifact("policy", "momentum");
    const scenarioHash = hashTextArtifact("scenario", "slippage_override");
    const nowSec = 1_800_000_000;

    const packet = await sandboxSigner.signEvidenceOnlyAction({
      chainId: 4663,
      verifyingContract: ctx.arenaAddress,
      runId,
      policyHash,
      scenarioHash,
      nonce: 1n,
      deadline: nowSec + 600,
      token: "0x0000000000000000000000000000000000E1E004",
      recipient: "0x00000000000000000000000000000000005A4DB0",
      amountWei: 100_000_000_000_000_000n,
      maxSlippageBps: 2500,
      actionCategory: 1,
    });

    const actionTuple = {
      runId: packet.action.runId,
      policyHash: packet.action.policyHash,
      scenarioHash: packet.action.scenarioHash,
      nonce: BigInt(packet.action.nonce),
      deadline: BigInt(packet.action.deadline),
      token: packet.action.token,
      recipient: packet.action.recipient,
      amount: BigInt(packet.action.amount),
      maxSlippageBps: packet.action.maxSlippageBps,
      actionCategory: packet.action.actionCategory,
      evidenceNoticeHash: packet.action.evidenceNoticeHash,
    };

    const [recoveredOnChain, digestOnChain] = await ctx.callView<[string, string]>(
      ctx.arenaAddress,
      "verifySimulatedActionSignature",
      [actionTuple, packet.signature]
    );
    expect(recoveredOnChain.toLowerCase()).toBe(sandboxSigner.address.toLowerCase());
    expect(digestOnChain.toLowerCase()).toBe(packet.digest.toLowerCase());

    const reportHash = hashTextArtifact("report", "json-001");
    const agentConfigHash = hashTextArtifact("cfg", "momentum-v1");
    const suiteVersionHash = keccak256(stringToHex("elenchi-suite-v1.1.0"));

    const permitSig = await signAttestationPermit({
      attestorPrivateKey: ATTESTOR_PK,
      chainId: 4663,
      verifyingContract: ctx.arenaAddress,
      permit: {
        runId,
        reportHash,
        policyHash,
        agentConfigHash,
        scenarioHash,
        suiteVersionHash,
        sandboxSigner: sandboxSigner.address,
        outcome: 1, // BREACHED
        attackClass: 4, // slippage_override
        failureKind: 1, // SIGNED_INVALID_ACTION
        riskSeverity: 3, // HIGH
        roundsAttempted: 2,
        roundsPassed: 1,
        requiresActionSig: true,
        actionStructHash: packet.structHash,
        attestorNonce: 101n,
        deadline: BigInt(nowSec + 600),
      },
    });

    const inputTuple = {
      runId,
      reportHash,
      policyHash,
      agentConfigHash,
      scenarioHash,
      suiteVersionHash,
      sandboxSigner: sandboxSigner.address,
      outcome: 1,
      attackClass: 4,
      failureKind: 1,
      riskSeverity: 3,
      roundsAttempted: 2,
      roundsPassed: 1,
      attestorNonce: 101n,
      deadline: BigInt(nowSec + 600),
    };

    // Pay 0.001 ETH when fee is 0.0005 ETH -> excess refunded, treasury gets exact 0.0005 ETH
    const regData = encodeFunctionData({
      abi: ARENA_ABI,
      functionName: "registerAttestation",
      args: [inputTuple, true, actionTuple, packet.signature, permitSig],
    });
    const txRes = await ctx.sendTx(USER_PK, ctx.arenaAddress, regData, 1_000_000_000_000_000n, BigInt(nowSec));
    expect(txRes.execResult.exceptionError).toBeUndefined();

    const treasuryAcct = await ctx.vm.stateManager.getAccount(new Address(hexToBytes(TREASURY_ADDR)));
    expect(treasuryAcct?.balance).toBe(500_000_000_000_000n);

    expect(await ctx.callView<boolean>(ctx.arenaAddress, "isRunAttested", [runId])).toBe(true);
    const rec = await ctx.callView<{ outcome: number; hasVerifiedActionSig: boolean; sandboxSigner: string }>(
      ctx.arenaAddress,
      "getAttestation",
      [runId]
    );
    expect(rec.outcome).toBe(1);
    expect(rec.hasVerifiedActionSig).toBe(true);
    expect(rec.sandboxSigner.toLowerCase()).toBe(sandboxSigner.address.toLowerCase());

    // Duplicate registration of same runId must revert
    const dupRes = await ctx.sendTx(USER_PK, ctx.arenaAddress, regData, 500_000_000_000_000n, BigInt(nowSec));
    expect(dupRes.execResult.exceptionError).toBeDefined();
  });

  it("rejects unauthorized attestors, cross-chain replay, expired signatures, and emergency pause", async () => {
    const ctx = await setupRobinhoodVm(46630, 0n);
    const sandboxSigner = createIsolatedSandboxSigner();
    const runId = runIdToBytes32("suite-pass-001");
    const policyHash = hashTextArtifact("policy", "strict");
    const scenarioHash = hashTextArtifact("scenario", "metadata_injection");
    const reportHash = hashTextArtifact("report", "pass-001");
    const agentConfigHash = hashTextArtifact("cfg", "strict-v1");
    const suiteVersionHash = keccak256(stringToHex("elenchi-suite-v1.1.0"));
    const nowSec = 1_800_000_000;

    const emptyAction = {
      runId: "0x0000000000000000000000000000000000000000000000000000000000000000" as const,
      policyHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as const,
      scenarioHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as const,
      nonce: 0n,
      deadline: 0n,
      token: "0x0000000000000000000000000000000000000000" as const,
      recipient: "0x0000000000000000000000000000000000000000" as const,
      amount: 0n,
      maxSlippageBps: 0,
      actionCategory: 0,
      evidenceNoticeHash: EVIDENCE_NOTICE_HASH,
    };

    const inputTuple = {
      runId,
      reportHash,
      policyHash,
      agentConfigHash,
      scenarioHash,
      suiteVersionHash,
      sandboxSigner: sandboxSigner.address,
      outcome: 2, // PASSED_SUITE
      attackClass: 1,
      failureKind: 0,
      riskSeverity: 0,
      roundsAttempted: 3,
      roundsPassed: 3,
      attestorNonce: 1n,
      deadline: BigInt(nowSec + 300),
    };

    // 1. Rogue signer permit rejected
    const roguePermit = await signAttestationPermit({
      attestorPrivateKey: ROGUE_PK,
      chainId: 46630,
      verifyingContract: ctx.arenaAddress,
      permit: {
        ...inputTuple,
        requiresActionSig: false,
        actionStructHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      },
    });
    const rogueData = encodeFunctionData({
      abi: ARENA_ABI,
      functionName: "registerAttestation",
      args: [inputTuple, false, emptyAction, "0x", roguePermit],
    });
    expect((await ctx.sendTx(USER_PK, ctx.arenaAddress, rogueData, 0n, BigInt(nowSec))).execResult.exceptionError).toBeDefined();

    // 2. Wrong chainId permit (signed for 4663, submitted on 46630) rejected
    const wrongChainPermit = await signAttestationPermit({
      attestorPrivateKey: ATTESTOR_PK,
      chainId: 4663,
      verifyingContract: ctx.arenaAddress,
      permit: {
        ...inputTuple,
        requiresActionSig: false,
        actionStructHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      },
    });
    const wrongChainData = encodeFunctionData({
      abi: ARENA_ABI,
      functionName: "registerAttestation",
      args: [inputTuple, false, emptyAction, "0x", wrongChainPermit],
    });
    expect((await ctx.sendTx(USER_PK, ctx.arenaAddress, wrongChainData, 0n, BigInt(nowSec))).execResult.exceptionError).toBeDefined();

    // 3. Valid permit rejected while paused, then succeeds after unpause
    const validPermit = await signAttestationPermit({
      attestorPrivateKey: ATTESTOR_PK,
      chainId: 46630,
      verifyingContract: ctx.arenaAddress,
      permit: {
        ...inputTuple,
        requiresActionSig: false,
        actionStructHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      },
    });
    const validData = encodeFunctionData({
      abi: ARENA_ABI,
      functionName: "registerAttestation",
      args: [inputTuple, false, emptyAction, "0x", validPermit],
    });

    await ctx.sendTx(
      OWNER_PK,
      ctx.arenaAddress,
      encodeFunctionData({ abi: ARENA_ABI, functionName: "setPaused", args: [true] })
    );
    expect((await ctx.sendTx(USER_PK, ctx.arenaAddress, validData, 0n, BigInt(nowSec))).execResult.exceptionError).toBeDefined();

    await ctx.sendTx(
      OWNER_PK,
      ctx.arenaAddress,
      encodeFunctionData({ abi: ARENA_ABI, functionName: "setPaused", args: [false] })
    );

    // Expired timestamp check
    expect((await ctx.sendTx(USER_PK, ctx.arenaAddress, validData, 0n, BigInt(nowSec + 999))).execResult.exceptionError).toBeDefined();

    // Succeeds within deadline
    const okRes = await ctx.sendTx(USER_PK, ctx.arenaAddress, validData, 0n, BigInt(nowSec + 50));
    expect(okRes.execResult.exceptionError).toBeUndefined();
  });

  it("enforces one-time Pons token binding, blocks non-contract addresses, and applies holder fee waiver", async () => {
    const ctx = await setupRobinhoodVm(4663, 500_000_000_000_000n);

    // Reject EOA binding (no bytecode)
    const badBind = encodeFunctionData({
      abi: ARENA_ABI,
      functionName: "bindElenchiTokenOnce",
      args: [ctx.userAddr, keccak256(stringToHex("fake-tx"))],
    });
    expect((await ctx.sendTx(OWNER_PK, ctx.arenaAddress, badBind)).execResult.exceptionError).toBeDefined();

    // Bind mock Pons ERC-20 once
    const goodBind = encodeFunctionData({
      abi: ARENA_ABI,
      functionName: "bindElenchiTokenOnce",
      args: [ctx.mockTokenAddress, keccak256(stringToHex("pons-launch-tx-real"))],
    });
    expect((await ctx.sendTx(OWNER_PK, ctx.arenaAddress, goodBind)).execResult.exceptionError).toBeUndefined();
    expect(await ctx.callView<boolean>(ctx.arenaAddress, "tokenBound")).toBe(true);

    // Second binding attempt reverts forever
    expect((await ctx.sendTx(OWNER_PK, ctx.arenaAddress, goodBind)).execResult.exceptionError).toBeDefined();

    // Before holding 1M tokens -> fee is 0.0005 ETH
    expect(await ctx.callView<bigint>(ctx.arenaAddress, "requiredFeeFor", [ctx.userAddr])).toBe(
      500_000_000_000_000n
    );

    // Credit 1,000,000 * 1e18 tokens -> fee waived to 0
    await ctx.sendTx(
      OWNER_PK,
      ctx.mockTokenAddress,
      encodeFunctionData({
        abi: MOCK_TOKEN_ABI,
        functionName: "setBalance",
        args: [ctx.userAddr, 1_000_000n * 10n ** 18n],
      })
    );
    expect(await ctx.callView<bigint>(ctx.arenaAddress, "requiredFeeFor", [ctx.userAddr])).toBe(0n);
  });
});
