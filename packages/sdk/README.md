# @agent-paymaster/sdk

Servo helpers for integrating the USDC paymaster on Taiko. Use alongside [viem](https://viem.sh) for full ERC-4337 account abstraction support.

## Install

```bash
npm install @agent-paymaster/sdk viem
```

## What this SDK does

This SDK provides only the Servo-specific helpers you need on top of viem:

| Function                        | Purpose                                                               |
| ------------------------------- | --------------------------------------------------------------------- |
| `ServoClient.getUsdcQuote()`    | Get a signed USDC quote from the Servo API                            |
| `applyPermitToPaymasterQuote()` | Inject your EIP-2612 permit signature into the quote's paymaster data |

Everything else — building UserOperations, estimating gas, sending transactions, signing permits — is handled by viem directly.

## Integration details

| Key                 | Value                                            |
| ------------------- | ------------------------------------------------ |
| **API endpoint**    | `https://api-production-cdfe.up.railway.app`     |
| **RPC endpoint**    | `https://api-production-cdfe.up.railway.app/rpc` |
| **Chain**           | Taiko Alethia (167000)                           |
| **EntryPoint v0.7** | `0x0000000071727De22E5E9d8BAf0edAc6f37da032`     |
| **USDC on Taiko**   | `0x07d83526730c7438048D55A4fC0b850e2aaB6f0b`     |
| **Paymaster**       | `0x57744E5dA1422Fb9Dd7E54D4f5f60Da6B1191852`     |

## Quick start

```ts
import { createPublicClient, http } from "viem";
import { ServoClient, applyPermitToPaymasterQuote } from "@agent-paymaster/sdk";

// ── 1. Create a Servo client ──

const servo = new ServoClient({
  apiUrl: "https://api-production-cdfe.up.railway.app",
});

// ── 2. Get a USDC quote ──
// Pass your UserOperation to get the exact USDC cost (includes 5% surcharge).

const quote = await servo.getUsdcQuote({
  chain: "taikoMainnet",
  entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  token: "USDC",
  userOperation: {
    sender: smartAccount.address,
    nonce: "0x1",
    initCode: "0x",
    callData: encodedTx,
    callGasLimit: gasEstimate.callGasLimit,
    verificationGasLimit: gasEstimate.verificationGasLimit,
    preVerificationGas: gasEstimate.preVerificationGas,
    maxFeePerGas: "0x5f5e100",
    maxPriorityFeePerGas: "0xf4240",
    signature: dummySignature,
  },
});

// quote.maxTokenCost     → "0.042000" (human-readable USDC)
// quote.maxTokenCostMicros → "42000"  (raw USDC micros)
// quote.validUntil       → 1741830000

// ── 3. Sign an EIP-2612 USDC permit with viem ──

const permitSignature = await walletClient.signTypedData({
  domain: {
    name: "USD Coin",
    version: "2",
    chainId: 167000,
    verifyingContract: quote.tokenAddress,
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
    owner: smartAccount.address,
    spender: quote.paymaster,
    value: BigInt(quote.maxTokenCostMicros),
    nonce: 0n, // your USDC permit nonce
    deadline: BigInt(quote.validUntil),
  },
});

// ── 4. Inject the permit into the quote ──

const finalQuote = applyPermitToPaymasterQuote(quote, {
  value: BigInt(quote.maxTokenCostMicros),
  deadline: BigInt(quote.validUntil),
  signature: permitSignature,
});

// ── 5. Send the UserOperation via Servo's bundler ──
// Use viem's standard JSON-RPC transport pointed at the Servo RPC endpoint.

const bundlerTransport = http("https://api-production-cdfe.up.railway.app/rpc");

const userOpHash = await publicClient.request({
  method: "eth_sendUserOperation",
  params: [
    {
      sender: smartAccount.address,
      nonce: "0x1",
      initCode: "0x",
      callData: encodedTx,
      callGasLimit: quote.callGasLimit,
      verificationGasLimit: quote.verificationGasLimit,
      preVerificationGas: quote.preVerificationGas,
      maxFeePerGas: "0x5f5e100",
      maxPriorityFeePerGas: "0xf4240",
      paymasterAndData: finalQuote.paymasterAndData,
      signature: userOpSignature,
    },
    "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  ],
});
```

## API reference

### `ServoClient`

```ts
const servo = new ServoClient({
  apiUrl: "https://api-production-cdfe.up.railway.app",
  timeoutMs: 10_000, // optional, default 10s
  headers: {}, // optional, extra headers
});

const quote = await servo.getUsdcQuote({ chain, entryPoint, token, userOperation });
```

### `applyPermitToPaymasterQuote(quote, permit)`

Injects a signed EIP-2612 permit into the Servo quote's `paymasterData`. The paymaster contract expects `paymasterData` to be ABI-encoded as `(QuoteStruct, quoteSignature, PermitStruct)`. The quote API returns this with an empty permit stub — this function replaces it with your actual permit.

```ts
const finalQuote = applyPermitToPaymasterQuote(quote, {
  value: BigInt(quote.maxTokenCostMicros),
  deadline: BigInt(quote.validUntil),
  signature: permitSignature, // from walletClient.signTypedData()
});
// Use finalQuote.paymasterAndData in your UserOperation
```

### Error classes

| Class              | When                                   |
| ------------------ | -------------------------------------- |
| `ServoError`       | Base class for all SDK errors          |
| `TransportError`   | Network failures or timeouts           |
| `HttpRequestError` | Non-2xx HTTP responses                 |
| `RateLimitError`   | 429 responses (has `limit`, `resetAt`) |
