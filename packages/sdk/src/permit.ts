import {
  type Address,
  type Hex,
  encodeFunctionData,
  hexToSignature,
  isAddress,
  parseAbi,
} from "viem";
import type { LocalAccount } from "viem/accounts";

const PERMIT_TYPE = [
  { name: "owner", type: "address" },
  { name: "spender", type: "address" },
  { name: "value", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;

export interface PermitTypedData {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: {
    Permit: typeof PERMIT_TYPE;
  };
  primaryType: "Permit";
  message: {
    owner: Address;
    spender: Address;
    value: bigint;
    nonce: bigint;
    deadline: bigint;
  };
}

export interface SignPermitInput {
  account: LocalAccount;
  owner: Address;
  spender: Address;
  tokenAddress: Address;
  chainId: number;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
  tokenName?: string;
  tokenVersion?: string;
}

/** Lightweight representation of a signed EIP-2612 permit, used to build on-chain permit calldata. */
export interface SignedPermitContext {
  value: string;
  deadline: string;
  signature: Hex;
}

export interface SignedPermit {
  typedData: PermitTypedData;
  signature: Hex;
  context: SignedPermitContext;
}

const assertAddress = (value: string, fieldName: string): Address => {
  if (!isAddress(value, { strict: false })) {
    throw new Error(`${fieldName} must be a valid address`);
  }

  return value.toLowerCase() as Address;
};

const assertNonNegative = (value: bigint, fieldName: string): bigint => {
  if (value < 0n) {
    throw new Error(`${fieldName} must be non-negative`);
  }

  return value;
};

export const buildPermitTypedData = (input: Omit<SignPermitInput, "account">): PermitTypedData => ({
  domain: {
    name: input.tokenName ?? "USD Coin",
    version: input.tokenVersion ?? "2",
    chainId: input.chainId,
    verifyingContract: assertAddress(input.tokenAddress, "tokenAddress"),
  },
  types: {
    Permit: PERMIT_TYPE,
  },
  primaryType: "Permit",
  message: {
    owner: assertAddress(input.owner, "owner"),
    spender: assertAddress(input.spender, "spender"),
    value: assertNonNegative(input.value, "value"),
    nonce: assertNonNegative(input.nonce, "nonce"),
    deadline: assertNonNegative(input.deadline, "deadline"),
  },
});

export const signPermit = async (input: SignPermitInput): Promise<SignedPermit> => {
  const typedData = buildPermitTypedData(input);

  const signature = (await input.account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  })) as Hex;

  return {
    typedData,
    signature,
    context: {
      value: typedData.message.value.toString(),
      deadline: typedData.message.deadline.toString(),
      signature,
    },
  };
};

const USDC_PERMIT_ABI = parseAbi([
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);

/**
 * Encodes an ERC-2612 `permit(owner, spender, value, deadline, v, r, s)` call for embedding in an
 * ERC-4337 account's callData. Use this to bootstrap USDC allowance to Servo's paymaster from the
 * very first sponsored UserOperation: wrap the resulting bytes in `execute(USDC, 0, permitCalldata)`.
 */
export const encodeUsdcPermitCalldata = (input: {
  owner: Address;
  spender: Address;
  value: bigint;
  deadline: bigint;
  signature: Hex;
}): Hex => {
  const { r, s, v } = hexToSignature(input.signature);
  if (v === undefined) {
    throw new Error("permit signature must include a v component");
  }

  return encodeFunctionData({
    abi: USDC_PERMIT_ABI,
    functionName: "permit",
    args: [input.owner, input.spender, input.value, input.deadline, Number(v), r, s],
  });
};
