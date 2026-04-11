import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { ServoClient } from "./client.js";
import { createAndExecute } from "./flow.js";

const OWNER_PK = "0x59c6995e998f97a5a0044966f0945386df7f5f0f6db9df9f8f9f7f5c5d6f7c1a" as const;
const COUNTERFACTUAL = "0x3333333333333333333333333333333333333333" as const;
const PAYMASTER_ADDR = "0x9999999999999999999999999999999999999999" as const;
const USDC_ADDR = "0x07d83526730c7438048d55a4fc0b850e2aab6f0b" as const;

const makeQuoteResult = (id: number) => ({
  jsonrpc: "2.0",
  id,
  result: {
    paymaster: PAYMASTER_ADDR,
    paymasterData: "0x12",
    paymasterAndData: `${PAYMASTER_ADDR}12`,
    callGasLimit: "0x88d8",
    verificationGasLimit: "0x1d4c8",
    preVerificationGas: "0x5274",
    paymasterVerificationGasLimit: "0xea60",
    paymasterPostOpGasLimit: "0xafc8",
    quoteId: `quote-${id}`,
    token: "USDC",
    tokenAddress: USDC_ADDR,
    maxTokenCost: "1.000000",
    maxTokenCostMicros: "1000000",
    validUntil: 1_900_000_000,
    isStub: false,
  },
});

const buildPublicClient = (allowance: bigint) => ({
  readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === "getAddress") return COUNTERFACTUAL;
    if (functionName === "nonces") return 7n;
    if (functionName === "allowance") return allowance;
    throw new Error(`Unexpected function: ${functionName}`);
  }),
});

const buildClient = (rpcMethods: string[]) =>
  new ServoClient({
    rpcUrl: "http://localhost:3000/rpc",
    fetchImpl: async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { method: string; id: number };
      rpcMethods.push(payload.method);

      if (
        payload.method === "pm_getPaymasterStubData" ||
        payload.method === "pm_getPaymasterData"
      ) {
        return new Response(JSON.stringify(makeQuoteResult(payload.id)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (payload.method === "eth_sendUserOperation") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: `0x${String(payload.id).padStart(64, "a")}`,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unexpected rpc method: ${payload.method}`);
    },
  });

describe("createAndExecute", () => {
  it("bootstraps with a setup userOp when allowance is insufficient", async () => {
    const rpcMethods: string[] = [];
    const client = buildClient(rpcMethods);
    const publicClient = buildPublicClient(0n);
    const owner = privateKeyToAccount(OWNER_PK);

    const result = await createAndExecute({
      client,
      publicClient: publicClient as unknown as Parameters<
        typeof createAndExecute
      >[0]["publicClient"],
      owner,
      entryPoint: "0x0000000071727de22e5e9d8baf0edac6f37da032",
      chain: "taikoMainnet",
      factoryAddress: "0x9999999999999999999999999999999999999999",
      salt: 123n,
      nonce: 0n,
      calls: [
        {
          target: "0x4444444444444444444444444444444444444444",
          value: 0n,
          data: "0x1234",
        },
      ],
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });

    // Expected RPC call sequence:
    //   1. stub quote (action draft)   → pm_getPaymasterStubData
    //   2. setup quote                 → pm_getPaymasterData
    //   3. setup submit                → eth_sendUserOperation
    //   4. action quote                → pm_getPaymasterData
    //   5. action submit               → eth_sendUserOperation
    expect(rpcMethods).toEqual([
      "pm_getPaymasterStubData",
      "pm_getPaymasterData",
      "eth_sendUserOperation",
      "pm_getPaymasterData",
      "eth_sendUserOperation",
    ]);
    expect(result.counterfactualAddress).toBe(COUNTERFACTUAL);
    expect(result.setupUserOperationHash).toBeDefined();
    expect(result.userOperationHash).toBeDefined();
  });

  it("skips the setup userOp when the account already has sufficient allowance", async () => {
    const rpcMethods: string[] = [];
    const client = buildClient(rpcMethods);
    const publicClient = buildPublicClient(10n ** 30n); // enormous pre-existing allowance
    const owner = privateKeyToAccount(OWNER_PK);

    const result = await createAndExecute({
      client,
      publicClient: publicClient as unknown as Parameters<
        typeof createAndExecute
      >[0]["publicClient"],
      owner,
      entryPoint: "0x0000000071727de22e5e9d8baf0edac6f37da032",
      chain: "taikoMainnet",
      factoryAddress: "0x9999999999999999999999999999999999999999",
      salt: 123n,
      nonce: 0n,
      calls: [
        {
          target: "0x4444444444444444444444444444444444444444",
          value: 0n,
          data: "0x1234",
        },
      ],
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });

    // No setup op: stub → action quote → action submit.
    expect(rpcMethods).toEqual([
      "pm_getPaymasterStubData",
      "pm_getPaymasterData",
      "eth_sendUserOperation",
    ]);
    expect(result.setupUserOperationHash).toBeUndefined();
    expect(result.userOperationHash).toBeDefined();
  });
});
