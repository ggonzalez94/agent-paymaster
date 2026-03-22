---
name: servo-agent
description: >
  How to make gasless transactions on Taiko using Servo — pay gas in USDC, no ETH needed.
  Use this skill whenever someone needs to transact on Taiko without ETH, create an ERC-4337
  smart account on Taiko, use a paymaster, pay gas fees in USDC or stablecoins, build a
  UserOperation for Taiko, or integrate with the Servo bundler. Also trigger when building
  AI agents that need onchain capabilities on Taiko, when the user mentions "Servo",
  "servo paymaster", "agent-paymaster", gasless transactions on Taiko, or USDC gas payment.
  Even if the user just says "I need to do something onchain on Taiko" — this skill applies.
---

# Servo: Gasless Transactions on Taiko

Servo is an ERC-4337 paymaster + bundler for Taiko. Agents pay gas in USDC — no ETH needed, ever.

**The core loop**: build a UserOp → Servo quotes the USDC gas cost → agent signs a USDC permit → Servo bundles and submits → on-chain contract settles actual cost and refunds surplus.

**Pricing**: 5% surcharge on gas cost, included in the quote. No API key, no signup.

**Standard tooling**: Use `viem` (or any ERC-4337 library). No proprietary SDK required — Servo exposes standard `pm_*` and `eth_*` JSON-RPC methods.

## Addresses — Taiko Mainnet (Chain 167000)

|                         | Address                                          |
| ----------------------- | ------------------------------------------------ |
| **Servo RPC**           | `https://api-production-cdfe.up.railway.app/rpc` |
| **TaikoUsdcPaymaster**  | `0xca675148201e29b13a848ce30c3074c8de995891`     |
| **ServoAccountFactory** | `0xCa245Ae9B786EF420Dc359430e5833b840880619`     |
| **EntryPoint v0.7**     | `0x0000000071727De22E5E9d8BAf0edAc6f37da032`     |
| **USDC**                | `0x07d83526730c7438048D55A4fc0b850e2aaB6f0b`     |
| **Taiko RPC**           | `https://rpc.mainnet.taiko.xyz`                  |

**This paymaster is currently not deployed on testnets, so it will only work on Taiko mainnet**

---

## Flow A: Cold Start — No Wallet Yet

The agent has a private key and USDC but no smart account. The account address is derived deterministically (CREATE2) and is usable _before_ deployment — USDC can be sent there immediately. The factory deploys it on the first UserOp.

### Step 1 — Derive the account address

Call the factory's `getAddress(owner, salt)` view function. This is a pure read — no transaction needed.

```typescript
import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const owner = privateKeyToAccount("0x<agent-private-key>");
const publicClient = createPublicClient({
  transport: http("https://rpc.mainnet.taiko.xyz"),
});

const FACTORY = "0xCa245Ae9B786EF420Dc359430e5833b840880619";
const factoryAbi = parseAbi([
  "function getAddress(address owner, uint256 salt) view returns (address)",
  "function createAccount(address owner, uint256 salt) returns (address)",
]);

const accountAddress = await publicClient.readContract({
  address: FACTORY,
  abi: factoryAbi,
  functionName: "getAddress",
  args: [owner.address, 0n], // salt 0n = primary account
});
// This address is deterministic and permanent — fund it with USDC now
```

### Step 2 — Fund with USDC

Transfer USDC to the derived address. The account contract doesn't exist yet — that's fine. ERC-20 balances are stored in the USDC contract keyed by address, so the funds will be there when the account deploys.

### Step 3 — Build initCode (first UserOp only)

The `initCode` tells the EntryPoint to deploy the account via the factory. After the first UserOp, set `initCode` to `"0x"`.

```typescript
import { encodeFunctionData, concat } from "viem";

const initCode = concat([
  FACTORY,
  encodeFunctionData({
    abi: factoryAbi,
    functionName: "createAccount",
    args: [owner.address, 0n],
  }),
]);
// For subsequent UserOps: initCode = "0x"
```

### Step 4 — Encode your call

ServoAccount exposes `execute(address, uint256, bytes)` for single calls and `executeBatch(address[], uint256[], bytes[])` for atomic batches.

```typescript
const accountAbi = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] datas)",
]);

// Single call to any contract:
const callData = encodeFunctionData({
  abi: accountAbi,
  functionName: "execute",
  args: ["0x<target-contract>", 0n, "0x<encoded-call>"],
});

// Batch (atomic, all-or-nothing):
const batchCallData = encodeFunctionData({
  abi: accountAbi,
  functionName: "executeBatch",
  args: [
    ["0x<token>", "0x<dex>"], // targets
    [0n, 0n], // values
    [approveCalldata, swapCalldata], // datas
  ],
});
```

### Step 5 — Get a paymaster quote (stub)

Call `pm_getPaymasterStubData` to learn the USDC cost. No permit needed yet.

```typescript
const SERVO_RPC = "https://api-production-cdfe.up.railway.app/rpc";
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

const stubResponse = await fetch(SERVO_RPC, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "pm_getPaymasterStubData",
    params: [
      {
        sender: accountAddress,
        nonce: "0x0",
        initCode,
        callData,
        maxFeePerGas: "0x2540be400", // 10 gwei
        maxPriorityFeePerGas: "0x3b9aca00", // 1 gwei
        signature: "0x",
      },
      ENTRY_POINT,
      "taikoMainnet",
    ],
  }),
});
const stub = (await stubResponse.json()).result;
// stub.maxTokenCost = "0.042000" (human-readable USDC)
// stub.maxTokenCostMicros = "42000" (use this for permit signing)
// stub.validUntil = 1710000090 (unix timestamp — quote expires in ~90s)
```

### Step 6 — Sign USDC permit (ERC-2612)

The agent signs a permit authorizing the paymaster to pull USDC from the smart account. The `owner` in the permit is the **smart account address**, not the EOA — the EOA just provides the signature. The paymaster contract calls `isValidSignature()` (ERC-1271) on the smart account to verify.

```typescript
const USDC = "0x07d83526730c7438048D55A4fc0b850e2aaB6f0b";

// Read the USDC permit nonce (0n for brand-new accounts)
const permitNonce = await publicClient.readContract({
  address: USDC,
  abi: parseAbi(["function nonces(address) view returns (uint256)"]),
  functionName: "nonces",
  args: [accountAddress],
});

const permitSignature = await owner.signTypedData({
  domain: {
    name: "USD Coin",
    version: "2",
    chainId: 167000,
    verifyingContract: USDC,
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
    owner: accountAddress, // smart account, NOT the EOA
    spender: stub.paymaster, // paymaster pulls USDC
    value: BigInt(stub.maxTokenCostMicros),
    nonce: permitNonce,
    deadline: BigInt(stub.validUntil),
  },
});
```

### Step 7 — Get final quote with permit

```typescript
const finalResponse = await fetch(SERVO_RPC, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "pm_getPaymasterData",
    params: [
      {
        sender: accountAddress,
        nonce: "0x0",
        initCode,
        callData,
        maxFeePerGas: "0x2540be400",
        maxPriorityFeePerGas: "0x3b9aca00",
        signature: "0x",
      },
      ENTRY_POINT,
      "taikoMainnet",
      {
        permit: {
          value: stub.maxTokenCostMicros,
          deadline: String(stub.validUntil),
          signature: permitSignature,
        },
      },
    ],
  }),
});
const quote = (await finalResponse.json()).result;
// quote.paymasterAndData — ready to include in UserOp
// quote.callGasLimit, verificationGasLimit, preVerificationGas — use these
```

### Step 8 — Sign and submit the UserOp

```typescript
import { getUserOperationHash } from "viem/account-abstraction";

const userOpHash = getUserOperationHash({
  userOperation: {
    sender: accountAddress,
    nonce: 0n,
    factory: FACTORY,
    factoryData: encodeFunctionData({
      abi: factoryAbi,
      functionName: "createAccount",
      args: [owner.address, 0n],
    }),
    callData,
    callGasLimit: BigInt(quote.callGasLimit),
    verificationGasLimit: BigInt(quote.verificationGasLimit),
    preVerificationGas: BigInt(quote.preVerificationGas),
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    paymaster: quote.paymaster,
    paymasterData: quote.paymasterData,
    paymasterVerificationGasLimit: BigInt(quote.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: BigInt(quote.paymasterPostOpGasLimit),
    signature: "0x",
  },
  entryPointAddress: ENTRY_POINT,
  entryPointVersion: "0.7",
  chainId: 167000,
});

const signature = await owner.signMessage({ message: { raw: userOpHash } });

// Submit with v0.7 packed format
const sendResponse = await fetch(SERVO_RPC, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "eth_sendUserOperation",
    params: [
      {
        sender: accountAddress,
        nonce: "0x0",
        initCode,
        callData,
        accountGasLimits:
          quote.accountGasLimits ??
          packGasLimits(BigInt(quote.verificationGasLimit), BigInt(quote.callGasLimit)),
        preVerificationGas: quote.preVerificationGas,
        gasFees: quote.gasFees ?? packGasLimits(1_000_000_000n, 10_000_000_000n),
        paymasterAndData: quote.paymasterAndData,
        signature,
      },
      ENTRY_POINT,
    ],
  }),
});
const opHash = (await sendResponse.json()).result;

// Helper: pack two uint128s into a bytes32
function packGasLimits(a: bigint, b: bigint): string {
  return "0x" + a.toString(16).padStart(32, "0") + b.toString(16).padStart(32, "0");
}
```

### Step 9 — Poll for receipt

```typescript
const checkReceipt = async (hash: string) => {
  const res = await fetch(SERVO_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "eth_getUserOperationReceipt",
      params: [hash],
    }),
  });
  return (await res.json()).result; // null if pending, receipt if mined
};
```

---

## Flow B: Existing 4337 Account

If you already have a deployed 4337 account (ServoAccount, Safe, Kernel, etc.), skip Steps 1-3. Set `initCode: "0x"` and use your account's own `callData` encoding. The rest of the flow (Steps 5-9) is the same.

**For non-ServoAccount wallets**: encode `callData` using your account's native interface (e.g., Safe's `executeUserOp`, Kernel's `execute`). The paymaster doesn't care which account implementation you use.

**ERC-1271 requirement**: The USDC permit's `owner` is the smart account, but the EOA signs it. USDC calls `isValidSignature()` on the account to verify. ServoAccount, Safe, and Kernel all implement this — but verify your account does too.

---

## RPC Reference

All methods go to `POST https://api-production-cdfe.up.railway.app/rpc`

| Method                        | Purpose                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| `pm_getPaymasterStubData`     | Estimate gas + USDC cost (no permit needed)                             |
| `pm_getPaymasterData`         | Get signed paymaster fields (pass permit in 4th param `context.permit`) |
| `pm_supportedEntryPoints`     | List supported entry points                                             |
| `pm_getCapabilities`          | Supported chains, tokens, factory address                               |
| `eth_sendUserOperation`       | Submit signed UserOp to bundler                                         |
| `eth_getUserOperationReceipt` | Check if UserOp was included                                            |
| `eth_getUserOperationByHash`  | Lookup UserOp by hash                                                   |
| `eth_chainId`                 | Returns chain ID (hex)                                                  |

### Quote response shape

```json
{
  "paymaster": "0x...",
  "paymasterData": "0x...",
  "paymasterAndData": "0x...",
  "callGasLimit": "0x...",
  "verificationGasLimit": "0x...",
  "preVerificationGas": "0x...",
  "paymasterVerificationGasLimit": "0x...",
  "paymasterPostOpGasLimit": "0x...",
  "quoteId": "f1a2b3...",
  "token": "USDC",
  "tokenAddress": "0x07d83526730c7438048D55A4fc0b850e2aaB6f0b",
  "maxTokenCost": "0.042000",
  "maxTokenCostMicros": "42000",
  "validUntil": 1710000090,
  "isStub": true
}
```

---

## Pitfalls — Read Before You Build

**Quote TTL is 90 seconds.** Get the quote, sign the permit, sign the UserOp, and submit — all within 90s. Don't hold quotes across long reasoning chains. If your agent is slow, separate "deciding what to do" from "executing the Servo flow" — decide first, then run steps 5-8 without pauses.

**Permit owner ≠ EOA.** The `owner` in the USDC permit is the **smart account** address, not the private key's EOA address. The EOA _signs_ the permit, but the permit says "the smart account authorizes the paymaster to pull its USDC." This is the #1 source of integration bugs.

**Stub → Final is two steps.** You must call `pm_getPaymasterStubData` first to learn the USDC cost, then sign a permit for that amount, then call `pm_getPaymasterData` with the permit. You can't skip the stub because you need the cost before you can sign the permit.

**USDC has 6 decimals.** `maxTokenCostMicros: "42000"` = 0.042 USDC. Use `maxTokenCostMicros` for permit signing, `maxTokenCost` for display.

**Counterfactual addresses are real.** You can send USDC to a derived address before the account exists on-chain. CREATE2 guarantees it always deploys to that address.

**v0.7 packed format.** Servo uses ERC-4337 v0.7. The `eth_sendUserOperation` expects packed fields (`accountGasLimits`, `gasFees` as bytes32 = two packed uint128s). The `pm_*` responses return individual fields — pack them for submission.

**5% surcharge is included.** The `maxTokenCost` in the quote already includes the surcharge.

**No ETH needed anywhere.** Not for account creation, not for gas, not for anything. USDC covers deployment + execution + gas — all in one UserOp.
