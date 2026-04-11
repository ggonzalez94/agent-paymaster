/**
 * E2E cold-start test on local Anvil.
 *
 * Deploys EntryPoint + MockUSDC + ServoPaymaster (Pimlico SingletonPaymasterV7 wrapper) +
 * ServoAccountFactory, creates an in-process API + Bundler, and verifies the complete zero-ETH
 * flow for a fresh agent account:
 *
 *   1. Setup UserOp: callData runs USDC.permit(MAX_UINT256) to grant the paymaster unlimited
 *      allowance. Account is deployed via initCode. Pimlico postOp pulls the setup gas cost in
 *      USDC (the permit ran before postOp, so allowance exists at settlement time).
 *   2. Action UserOp: callData runs execute(USDC, 0, transfer(recipient, amount)). No initCode
 *      (account already deployed). postOp pulls the action gas cost in USDC.
 *
 * Run:  RUN_E2E_ANVIL=1 pnpm --filter @agent-paymaster/api vitest run e2e-anvil
 *
 * Requires: anvil + forge (Foundry), all workspace packages built.
 * Not part of CI — run manually to validate the full on-chain flow.
 */
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  maxUint256,
  parseAbi,
  toHex,
  type Hex,
} from "viem";
import { getUserOperationHash } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { BundlerService, type HexString } from "@agent-paymaster/bundler";

import { createApp } from "./index.js";
import { StaticPriceProvider } from "./paymaster-service.js";
import type { JsonRpcRequest, JsonRpcResponse, DependencyHealth } from "./types.js";

// ---------------------------------------------------------------------------
// Gate: skip the entire suite unless explicitly enabled
// ---------------------------------------------------------------------------
const runE2E = process.env.RUN_E2E_ANVIL === "1";

// ---------------------------------------------------------------------------
// Anvil well-known keys (deterministic from "test test test..." mnemonic)
// ---------------------------------------------------------------------------
const DEPLOYER_PK: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const QUOTE_SIGNER_PK: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SUBMITTER_PK: Hex = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const AGENT_PK: Hex = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const QUOTE_SIGNER_ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ANVIL_RPC = "http://127.0.0.1:8545";
const CHAIN_ID = 167000;
const FIXTURE_PATH = "/tmp/servo-anvil-fixture.json";
const RECIPIENT = "0xa935CEC3c5Ef99D7F1016674DEFd455Ef06776C5";
const SALT = 0n;
const INITIAL_USDC = 10_000_000n; // 10 USDC (6 decimals)
const TRANSFER_AMOUNT = 10_000n; // 0.01 USDC
const DUMMY_SIG: Hex = `0x${"00".repeat(65)}`;
const USDC_PER_ETH_MICROS = 2_500_000_000n; // $2500 per ETH

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface AnvilFixture {
  entryPoint: Hex;
  usdc: Hex;
  paymaster: Hex;
  factory: Hex;
}

// ---------------------------------------------------------------------------
// Chain definition for viem clients
// ---------------------------------------------------------------------------
const anvilChain = {
  id: CHAIN_ID,
  name: "anvil-taiko",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
} as const;

// ---------------------------------------------------------------------------
// Contract ABIs
// ---------------------------------------------------------------------------
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function mint(address,uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function nonces(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const USDC_PERMIT_ABI = parseAbi([
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);
const FACTORY_ABI = parseAbi([
  "function getAddress(address,uint256) view returns (address)",
  "function createAccount(address,uint256) returns (address)",
]);
const ACCOUNT_ABI = parseAbi(["function execute(address,uint256,bytes)"]);
const HANDLE_OPS_ABI = parseAbi([
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address payable beneficiary)",
  "error FailedOp(uint256 opIndex, string reason)",
  "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spawn Anvil and wait for "Listening on" before resolving. */
const spawnAnvil = (): Promise<ChildProcess> =>
  new Promise((ok, fail) => {
    const child = spawn("anvil", ["--chain-id", String(CHAIN_ID)], {
      stdio: "pipe",
    });
    child.on("error", fail);
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes("Listening on")) {
        child.stdout?.off("data", onData);
        ok(child);
      }
    };
    child.stdout?.on("data", onData);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error("Anvil failed to start within 10s"));
    }, 10_000);
    child.on("exit", () => clearTimeout(timer));
  });

/** Deploy the full Servo contract stack via forge script and return fixture addresses. */
const deployFixture = (): AnvilFixture => {
  try {
    execSync(
      `DEPLOYER_PRIVATE_KEY=${DEPLOYER_PK} QUOTE_SIGNER_ADDRESS=${QUOTE_SIGNER_ADDR} FIXTURE_OUTPUT_PATH=${FIXTURE_PATH} forge script script/DeployAnvilFixture.s.sol --rpc-url ${ANVIL_RPC} --broadcast`,
      { cwd: resolve(process.cwd(), "..", "paymaster-contracts"), stdio: "pipe", timeout: 60_000 },
    );
  } catch (error: unknown) {
    const stderr =
      error instanceof Error && "stderr" in error ? (error as { stderr: Buffer }).stderr : null;
    const msg = stderr ? stderr.toString().slice(0, 2000) : "unknown error";
    throw new Error(`Forge deploy failed:\n${msg}`);
  }
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as AnvilFixture;
};

/** Send a JSON-RPC request through the Hono app and return the result. */
const appRpc = async (
  app: { request: (path: string, init: RequestInit) => Promise<Response> },
  method: string,
  params: unknown[],
): Promise<Record<string, unknown>> => {
  const res = await app.request("/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as Record<string, unknown>;
};

/** Split a 65-byte compact signature into (v, r, s) components. */
const splitSig = (sig: Hex): { v: number; r: Hex; s: Hex } => {
  const bytes = sig.slice(2);
  const r = `0x${bytes.slice(0, 64)}` as Hex;
  const s = `0x${bytes.slice(64, 128)}` as Hex;
  const v = Number.parseInt(bytes.slice(128, 130), 16);
  return { v, r, s };
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.runIf(runE2E)("E2E: Anvil cold-start (Pimlico two-op bootstrap)", () => {
  let anvil: ChildProcess;
  let fixture: AnvilFixture;
  let app: ReturnType<typeof createApp>;
  let counterfactual: Hex;

  // Shared state built progressively across ordered test steps
  let factoryCalldata: Hex;
  let initCode: Hex;
  let transferCallData: Hex;
  let gasPrice: bigint;

  // -------------------------------------------------------------------------
  // Setup: Anvil + contracts + USDC funding + in-process API
  // -------------------------------------------------------------------------
  beforeAll(async () => {
    anvil = await spawnAnvil();
    fixture = deployFixture();

    const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
    const agent = privateKeyToAccount(AGENT_PK);
    const deployer = privateKeyToAccount(DEPLOYER_PK);
    const walletClient = createWalletClient({
      chain: anvilChain,
      transport: http(ANVIL_RPC),
      account: deployer,
    });

    // Derive counterfactual account address
    counterfactual = (await publicClient.readContract({
      address: fixture.factory,
      abi: FACTORY_ABI,
      functionName: "getAddress",
      args: [agent.address, SALT],
    })) as Hex;

    // Mint USDC to the counterfactual address (account not deployed yet)
    const mintHash = await walletClient.writeContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "mint",
      args: [counterfactual, INITIAL_USDC],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });

    // Wire up in-process bundler + API
    const bundlerService = new BundlerService({
      chainId: CHAIN_ID,
      entryPoints: [fixture.entryPoint as HexString],
      paymasterVerificationGasLimit: 200_000n,
    });
    const bundlerClient = {
      async rpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
        return bundlerService.handleJsonRpc(request);
      },
      async health(): Promise<DependencyHealth> {
        return { status: "ok", latencyMs: 0, details: bundlerService.getHealth() };
      },
    };
    app = createApp({
      bundlerClient,
      entryPointMonitor: null,
      config: {
        paymaster: {
          priceProvider: new StaticPriceProvider(USDC_PER_ETH_MICROS),
          quoteSignerPrivateKey: QUOTE_SIGNER_PK,
          paymasterAddress: fixture.paymaster,
          supportedEntryPoints: [fixture.entryPoint],
          tokenAddresses: {
            taikoMainnet: fixture.usdc,
            taikoHoodi: fixture.usdc,
          },
        },
      },
    });
  }, 90_000);

  afterAll(async () => {
    if (anvil) {
      anvil.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        anvil.once("exit", () => resolve());
        setTimeout(() => {
          if (!anvil.killed) anvil.kill("SIGKILL");
          resolve();
        }, 2_000);
      });
    }
    try {
      unlinkSync(FIXTURE_PATH);
    } catch {
      /* cleanup — file may not exist */
    }
  });

  // -------------------------------------------------------------------------
  // Pre-flight: verify fresh state
  // -------------------------------------------------------------------------
  it("counterfactual account has USDC, no code, no ETH", async () => {
    const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
    const agent = privateKeyToAccount(AGENT_PK);

    factoryCalldata = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "createAccount",
      args: [agent.address, SALT],
    });
    initCode = `${fixture.factory.toLowerCase()}${factoryCalldata.slice(2)}` as Hex;

    const transferInner = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [RECIPIENT, TRANSFER_AMOUNT],
    });
    transferCallData = encodeFunctionData({
      abi: ACCOUNT_ABI,
      functionName: "execute",
      args: [fixture.usdc, 0n, transferInner],
    });
    gasPrice = await publicClient.getGasPrice();

    const code = await publicClient.getCode({ address: counterfactual });
    expect(code === undefined || code === "0x").toBe(true);

    const ethBalance = await publicClient.getBalance({ address: counterfactual });
    expect(ethBalance).toBe(0n);

    const usdcBalance = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [counterfactual],
    })) as bigint;
    expect(usdcBalance).toBe(INITIAL_USDC);

    const allowance = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [counterfactual, fixture.paymaster],
    })) as bigint;
    expect(allowance).toBe(0n);
  });

  // -------------------------------------------------------------------------
  // Setup op: deploy account + run USDC.permit(MAX_UINT256) + pay in USDC
  // -------------------------------------------------------------------------
  it("setup UserOp deploys the account and establishes unlimited USDC allowance", async () => {
    const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
    const agent = privateKeyToAccount(AGENT_PK);
    const submitter = privateKeyToAccount(SUBMITTER_PK);
    const submitterWallet = createWalletClient({
      chain: anvilChain,
      transport: http(ANVIL_RPC),
      account: submitter,
    });

    // 1. Sign an EIP-2612 permit granting unlimited allowance to the paymaster.
    const permitNonce = await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "nonces",
      args: [counterfactual],
    });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const permitSig = await agent.signTypedData({
      domain: {
        name: "Mock USDC",
        version: "2",
        chainId: CHAIN_ID,
        verifyingContract: fixture.usdc,
      },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: {
        owner: counterfactual,
        spender: getAddress(fixture.paymaster),
        value: maxUint256,
        nonce: permitNonce,
        deadline,
      },
    });
    const { v, r, s } = splitSig(permitSig);

    // 2. Encode the account's callData as execute(USDC, 0, permit(owner, paymaster, MAX, ...)).
    const permitCalldata = encodeFunctionData({
      abi: USDC_PERMIT_ABI,
      functionName: "permit",
      args: [counterfactual, getAddress(fixture.paymaster), maxUint256, deadline, v, r, s],
    });
    const setupCallData = encodeFunctionData({
      abi: ACCOUNT_ABI,
      functionName: "execute",
      args: [fixture.usdc, 0n, permitCalldata],
    });

    // 3. Quote the setup UserOp via the API. Gas limits must be generous because of initCode.
    const draftSetupUserOp = {
      sender: counterfactual,
      nonce: "0x0",
      initCode,
      callData: setupCallData,
      callGasLimit: toHex(200_000n),
      verificationGasLimit: toHex(700_000n),
      preVerificationGas: toHex(50_000n),
      maxFeePerGas: toHex(gasPrice),
      maxPriorityFeePerGas: toHex(gasPrice),
      signature: DUMMY_SIG,
    };

    const pm = (await appRpc(app, "pm_getPaymasterData", [
      draftSetupUserOp,
      fixture.entryPoint,
      "taikoMainnet",
    ])) as Record<string, string>;

    expect(pm.isStub).toBe(false);
    expect(getAddress(pm.paymaster)).toBe(getAddress(fixture.paymaster));
    // Inner paymasterData must start with Pimlico's ERC-20 mode + allowAllBundlers byte (0x03).
    expect(pm.paymasterData.slice(2, 4)).toBe("03");

    // 4. Sign the UserOp hash with the account owner's key (ServoAccount validates via personal_sign).
    const apiVGL = BigInt(pm.verificationGasLimit);
    const apiCGL = BigInt(pm.callGasLimit);
    const apiPVG = BigInt(pm.preVerificationGas);
    const pmVGL = BigInt(pm.paymasterVerificationGasLimit);
    const pmPOGL = BigInt(pm.paymasterPostOpGasLimit);

    const setupUserOpHash = getUserOperationHash({
      userOperation: {
        sender: counterfactual,
        nonce: 0n,
        factory: fixture.factory,
        factoryData: factoryCalldata,
        callData: setupCallData,
        callGasLimit: apiCGL,
        verificationGasLimit: apiVGL,
        preVerificationGas: apiPVG,
        maxFeePerGas: gasPrice,
        maxPriorityFeePerGas: gasPrice,
        paymaster: pm.paymaster as Hex,
        paymasterData: pm.paymasterData as Hex,
        paymasterVerificationGasLimit: pmVGL,
        paymasterPostOpGasLimit: pmPOGL,
        signature: DUMMY_SIG,
      },
      entryPointAddress: fixture.entryPoint,
      entryPointVersion: "0.7",
      chainId: CHAIN_ID,
    });
    const setupUserOpSig = await agent.signMessage({ message: { raw: setupUserOpHash } });

    // 5. Submit handleOps.
    const accountGasLimits = concatHex([toHex(apiVGL, { size: 16 }), toHex(apiCGL, { size: 16 })]);
    const gasFees = concatHex([toHex(gasPrice, { size: 16 }), toHex(gasPrice, { size: 16 })]);

    const setupTxHash = await submitterWallet.writeContract({
      address: fixture.entryPoint,
      abi: HANDLE_OPS_ABI,
      functionName: "handleOps",
      args: [
        [
          {
            sender: counterfactual,
            nonce: 0n,
            initCode,
            callData: setupCallData,
            accountGasLimits,
            preVerificationGas: apiPVG,
            gasFees,
            paymasterAndData: pm.paymasterAndData as Hex,
            signature: setupUserOpSig,
          },
        ],
        submitter.address,
      ],
      gas: 3_000_000n,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: setupTxHash });
    expect(receipt.status).toBe("success");

    // 6. Verify post-conditions:
    //    - Account is deployed
    //    - Allowance to paymaster is MAX_UINT256
    //    - Account USDC balance dropped by the setup gas fee only (nothing transferred out)
    //    - Paymaster received a non-zero USDC fee
    const code = await publicClient.getCode({ address: counterfactual });
    expect(code).toBeDefined();
    expect(code!.length).toBeGreaterThan(2);

    const allowance = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [counterfactual, fixture.paymaster],
    })) as bigint;
    expect(allowance).toBe(maxUint256);

    const paymasterBalance = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [fixture.paymaster],
    })) as bigint;
    expect(paymasterBalance).toBeGreaterThan(0n);

    const accountUsdc = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [counterfactual],
    })) as bigint;
    // Setup op doesn't transfer to any user, so the delta is purely the gas fee. Anvil's
    // default base fee is high relative to our static oracle price, so the fee can be several
    // USDC for a cold-start deployment — we just assert the account is still solvent.
    expect(accountUsdc).toBeLessThan(INITIAL_USDC);
    expect(accountUsdc).toBeGreaterThan(TRANSFER_AMOUNT); // must still afford the action op

    console.log(
      `Setup: account USDC ${formatUnits(INITIAL_USDC, 6)} -> ${formatUnits(accountUsdc, 6)} | paymaster fee: ${formatUnits(INITIAL_USDC - accountUsdc, 6)}`,
    );
  }, 60_000);

  // -------------------------------------------------------------------------
  // Action op: transfer USDC using the persistent allowance
  // -------------------------------------------------------------------------
  it("action UserOp executes the USDC transfer and pays gas in USDC", async () => {
    const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
    const agent = privateKeyToAccount(AGENT_PK);
    const submitter = privateKeyToAccount(SUBMITTER_PK);
    const submitterWallet = createWalletClient({
      chain: anvilChain,
      transport: http(ANVIL_RPC),
      account: submitter,
    });

    // Account already deployed — no initCode, nonce=1.
    const draftActionUserOp = {
      sender: counterfactual,
      nonce: "0x1",
      initCode: "0x",
      callData: transferCallData,
      callGasLimit: toHex(100_000n),
      verificationGasLimit: toHex(150_000n),
      preVerificationGas: toHex(50_000n),
      maxFeePerGas: toHex(gasPrice),
      maxPriorityFeePerGas: toHex(gasPrice),
      signature: DUMMY_SIG,
    };

    const pm = (await appRpc(app, "pm_getPaymasterData", [
      draftActionUserOp,
      fixture.entryPoint,
      "taikoMainnet",
    ])) as Record<string, string>;

    expect(pm.isStub).toBe(false);

    const apiVGL = BigInt(pm.verificationGasLimit);
    const apiCGL = BigInt(pm.callGasLimit);
    const apiPVG = BigInt(pm.preVerificationGas);
    const pmVGL = BigInt(pm.paymasterVerificationGasLimit);
    const pmPOGL = BigInt(pm.paymasterPostOpGasLimit);

    const actionUserOpHash = getUserOperationHash({
      userOperation: {
        sender: counterfactual,
        nonce: 1n,
        callData: transferCallData,
        callGasLimit: apiCGL,
        verificationGasLimit: apiVGL,
        preVerificationGas: apiPVG,
        maxFeePerGas: gasPrice,
        maxPriorityFeePerGas: gasPrice,
        paymaster: pm.paymaster as Hex,
        paymasterData: pm.paymasterData as Hex,
        paymasterVerificationGasLimit: pmVGL,
        paymasterPostOpGasLimit: pmPOGL,
        signature: DUMMY_SIG,
      },
      entryPointAddress: fixture.entryPoint,
      entryPointVersion: "0.7",
      chainId: CHAIN_ID,
    });
    const actionUserOpSig = await agent.signMessage({ message: { raw: actionUserOpHash } });

    const accountGasLimits = concatHex([toHex(apiVGL, { size: 16 }), toHex(apiCGL, { size: 16 })]);
    const gasFees = concatHex([toHex(gasPrice, { size: 16 }), toHex(gasPrice, { size: 16 })]);

    const accountUsdcBefore = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [counterfactual],
    })) as bigint;

    let actionTxHash: Hex;
    try {
      actionTxHash = await submitterWallet.writeContract({
        address: fixture.entryPoint,
        abi: HANDLE_OPS_ABI,
        functionName: "handleOps",
        args: [
          [
            {
              sender: counterfactual,
              nonce: 1n,
              initCode: "0x",
              callData: transferCallData,
              accountGasLimits,
              preVerificationGas: apiPVG,
              gasFees,
              paymasterAndData: pm.paymasterAndData as Hex,
              signature: actionUserOpSig,
            },
          ],
          submitter.address,
        ],
        gas: 2_000_000n,
      });
    } catch (error) {
      console.error("action handleOps write failed", error);
      throw error;
    }

    console.log(`action tx submitted: ${actionTxHash}`);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: actionTxHash,
      timeout: 60_000,
    });
    console.log(`action tx status: ${receipt.status}`);
    expect(receipt.status).toBe("success");

    // Verify: recipient got the transfer, account paid transfer + gas, account still has zero ETH.
    const recipientUsdc = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [RECIPIENT],
    })) as bigint;
    expect(recipientUsdc).toBe(TRANSFER_AMOUNT);

    const accountUsdcAfter = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [counterfactual],
    })) as bigint;
    // Action op paid: transfer (10k micro USDC) + some gas fee.
    expect(accountUsdcAfter).toBeLessThan(accountUsdcBefore - TRANSFER_AMOUNT);

    const accountEth = await publicClient.getBalance({ address: counterfactual });
    expect(accountEth).toBe(0n);

    console.log(
      `Action: recipient USDC ${formatUnits(recipientUsdc, 6)} | account USDC ${formatUnits(accountUsdcBefore, 6)} -> ${formatUnits(accountUsdcAfter, 6)} | action fee: ${formatUnits(accountUsdcBefore - accountUsdcAfter - TRANSFER_AMOUNT, 6)}`,
    );
  }, 120_000);
});
