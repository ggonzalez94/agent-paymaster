import { describe, expect, it } from "vitest";
import { encodeAbiParameters } from "viem";

import { ServoError } from "./errors.js";
import { applyPermitToPaymasterQuote } from "./paymaster-data.js";
import type { PaymasterRpcResult } from "./types.js";

const PAYMASTER_DATA_PARAMETERS = [
  {
    type: "tuple",
    name: "quote",
    components: [
      { name: "token", type: "address" },
      { name: "exchangeRate", type: "uint256" },
      { name: "maxTokenCost", type: "uint256" },
      { name: "validAfter", type: "uint48" },
      { name: "validUntil", type: "uint48" },
      { name: "postOpOverheadGas", type: "uint32" },
      { name: "surchargeBps", type: "uint16" },
    ],
  },
  {
    type: "bytes",
    name: "quoteSignature",
  },
  {
    type: "tuple",
    name: "permit",
    components: [
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
  },
] as const;

const makeQuote = (paymasterData: `0x${string}`): PaymasterRpcResult => {
  const paymaster = "0x9999999999999999999999999999999999999999" as const;
  const verificationGas = "0000000000000000000000000000ea60";
  const postOpGas = "000000000000000000000000000afc80";
  const paymasterAndData =
    `${paymaster}${verificationGas}${postOpGas}${paymasterData.slice(2)}` as `0x${string}`;

  return {
    paymaster,
    paymasterData,
    paymasterAndData,
    callGasLimit: "0x88d8",
    verificationGasLimit: "0x1d4c8",
    preVerificationGas: "0x5274",
    paymasterVerificationGasLimit: "0xea60",
    paymasterPostOpGasLimit: "0xafc80",
    quoteId: "test-quote-id",
    token: "USDC",
    tokenAddress: "0x9999999999999999999999999999999999999999",
    maxTokenCost: "0.000100",
    maxTokenCostMicros: "100",
    validUntil: 1_900_000_000,
    isStub: false,
  };
};

describe("applyPermitToPaymasterQuote", () => {
  it("injects a permit into a quote with a stub permit", () => {
    const paymasterData = encodeAbiParameters(PAYMASTER_DATA_PARAMETERS, [
      {
        token: "0x9999999999999999999999999999999999999999",
        exchangeRate: 1_000_000n,
        maxTokenCost: 100n,
        validAfter: 1,
        validUntil: 2,
        postOpOverheadGas: 45_000,
        surchargeBps: 500,
      },
      "0x1234",
      { value: 0n, deadline: 0n, signature: "0x" },
    ]);

    const quote = makeQuote(paymasterData);

    const result = applyPermitToPaymasterQuote(quote, {
      value: 150n,
      deadline: 1_900_000_000n,
      signature: "0xaabbcc",
    });

    expect(result.paymasterData).not.toBe(quote.paymasterData);
    expect(result.paymasterAndData).not.toBe(quote.paymasterAndData);
    expect(result.paymasterAndData).toContain("aabbcc");
  });

  it("throws when permit value is below maxTokenCostMicros", () => {
    const paymasterData = encodeAbiParameters(PAYMASTER_DATA_PARAMETERS, [
      {
        token: "0x9999999999999999999999999999999999999999",
        exchangeRate: 1_000_000n,
        maxTokenCost: 100n,
        validAfter: 1,
        validUntil: 2,
        postOpOverheadGas: 45_000,
        surchargeBps: 500,
      },
      "0x1234",
      { value: 0n, deadline: 0n, signature: "0x" },
    ]);

    const quote = makeQuote(paymasterData);

    expect(() =>
      applyPermitToPaymasterQuote(quote, {
        value: 50n,
        deadline: 1_900_000_000n,
        signature: "0xaabbcc",
      }),
    ).toThrow(ServoError);
  });
});
