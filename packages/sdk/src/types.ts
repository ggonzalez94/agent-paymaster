import type { Address, Hex } from "viem";

export type ChainName = "taikoMainnet" | "taikoHoodi";

export interface ServoCall {
  target: Address;
  value?: bigint;
  data: Hex;
}

/** Servo-specific response from pm_getPaymasterData / pm_getPaymasterStubData. */
export interface PaymasterQuote {
  paymaster: Address;
  paymasterData: Hex;
  paymasterAndData: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  paymasterVerificationGasLimit: Hex;
  paymasterPostOpGasLimit: Hex;
  quoteId: string;
  token: "USDC";
  tokenAddress: Address;
  maxTokenCost: string;
  maxTokenCostMicros: string;
  validUntil: number;
  isStub: boolean;
}

export interface CreateAndExecuteResult {
  counterfactualAddress: Address;
  quote: PaymasterQuote;
  userOperationHash: Hex;
  /**
   * Hash of the one-time bootstrap UserOperation Servo sends when the account has no USDC allowance for
   * the paymaster. Only set on first use of a given account; subsequent runs reuse the persistent
   * allowance established by that setup op.
   */
  setupUserOperationHash?: Hex;
}
