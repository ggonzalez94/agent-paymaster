import { type Address, type Hex, maxUint256, parseAbi, toHex, type PublicClient } from "viem";
import { getUserOperationHash } from "viem/account-abstraction";
import type { LocalAccount } from "viem/accounts";

import type { ServoClient } from "./client.js";
import { encodeUsdcPermitCalldata, signPermit } from "./permit.js";
import {
  buildInitCode,
  buildServoCallData,
  buildServoExecuteCallData,
  getCounterfactualAddress,
} from "./servo-account.js";
import type { ChainName, CreateAndExecuteResult, ServoCall } from "./types.js";

const ERC20_VIEW_ABI = parseAbi([
  "function nonces(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const DUMMY_SIGNATURE: Hex = `0x${"00".repeat(65)}`;

const CHAIN_IDS: Record<ChainName, number> = {
  taikoMainnet: 167000,
  taikoHoodi: 167013,
};

export interface CreateAndExecuteInput {
  client: ServoClient;
  publicClient: PublicClient;
  owner: LocalAccount;
  entryPoint: Address;
  chain: ChainName | number;
  factoryAddress: Address;
  salt: bigint;
  nonce: bigint;
  calls: ServoCall[];
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Optional override for the permit deadline. Defaults to the quote's `validUntil`. */
  permitDeadline?: bigint;
  tokenName?: string;
  tokenVersion?: string;
}

/**
 * Sends a sponsored UserOperation from a counterfactual Servo account. If the account hasn't yet
 * approved the paymaster to pull USDC, this also issues a one-time bootstrap UserOperation whose
 * only job is to run an EIP-2612 `permit` against the USDC contract, granting the paymaster an
 * unlimited allowance. Subsequent calls reuse that allowance and skip the setup op.
 *
 * This pattern replaces the old approach of bundling a permit blob into `paymasterAndData`: Pimlico's
 * SingletonPaymasterV7 has no permit field, so the permit has to run inside the account's execution.
 */
export const createAndExecute = async (
  input: CreateAndExecuteInput,
): Promise<CreateAndExecuteResult> => {
  const chainId = typeof input.chain === "number" ? input.chain : CHAIN_IDS[input.chain];
  const ownerAddress = input.owner.address;

  // 1. Derive counterfactual account + initCode.
  const counterfactualAddress = await getCounterfactualAddress({
    publicClient: input.publicClient,
    factoryAddress: input.factoryAddress,
    owner: ownerAddress,
    salt: input.salt,
  });

  const initCode = buildInitCode({
    factoryAddress: input.factoryAddress,
    owner: ownerAddress,
    salt: input.salt,
  });
  const factoryData: Hex = `0x${initCode.slice(42)}`;

  // 2. Stub quote to learn paymaster address, token address, and cost bounds.
  const draftActionUserOp = {
    sender: counterfactualAddress,
    nonce: toHex(input.nonce),
    initCode,
    callData: buildServoCallData(input.calls),
    maxFeePerGas: toHex(input.maxFeePerGas),
    maxPriorityFeePerGas: toHex(input.maxPriorityFeePerGas),
    signature: DUMMY_SIGNATURE,
  };

  const stubQuote = await input.client.getPaymasterStubData(
    draftActionUserOp,
    input.entryPoint,
    input.chain,
  );

  // 3. Check the existing USDC allowance from the counterfactual account to the paymaster. If the
  //    contract isn't deployed yet the read returns 0, which correctly triggers a setup op.
  const existingAllowance = await input.publicClient
    .readContract({
      address: stubQuote.tokenAddress,
      abi: ERC20_VIEW_ABI,
      functionName: "allowance",
      args: [counterfactualAddress, stubQuote.paymaster],
    })
    .catch(() => 0n);

  const requiredAllowance = BigInt(stubQuote.maxTokenCostMicros);
  const needsSetup = existingAllowance < requiredAllowance;

  let setupUserOperationHash: Hex | undefined;
  let actionNonce = input.nonce;
  let actionInitCode: Hex = initCode;

  // 4. If the account has no allowance, send a bootstrap UserOp that only runs the permit. This also
  //    deploys the account (via initCode). Subsequent action ops can skip initCode + setup.
  if (needsSetup) {
    const permitNonce = await input.publicClient.readContract({
      address: stubQuote.tokenAddress,
      abi: ERC20_VIEW_ABI,
      functionName: "nonces",
      args: [counterfactualAddress],
    });

    const quoteDeadline = BigInt(stubQuote.validUntil);
    const permitDeadline =
      input.permitDeadline !== undefined && input.permitDeadline < quoteDeadline
        ? input.permitDeadline
        : quoteDeadline;

    // Grant unlimited allowance so the paymaster never has to re-permit.
    const signedPermit = await signPermit({
      account: input.owner,
      owner: counterfactualAddress,
      spender: stubQuote.paymaster,
      tokenAddress: stubQuote.tokenAddress,
      chainId,
      value: maxUint256,
      nonce: permitNonce,
      deadline: permitDeadline,
      tokenName: input.tokenName,
      tokenVersion: input.tokenVersion,
    });

    const permitCalldata = encodeUsdcPermitCalldata({
      owner: counterfactualAddress,
      spender: stubQuote.paymaster,
      value: maxUint256,
      deadline: permitDeadline,
      signature: signedPermit.signature,
    });

    const setupCallData = buildServoExecuteCallData({
      target: stubQuote.tokenAddress,
      value: 0n,
      data: permitCalldata,
    });

    const draftSetupUserOp = {
      sender: counterfactualAddress,
      nonce: toHex(input.nonce),
      initCode,
      callData: setupCallData,
      maxFeePerGas: toHex(input.maxFeePerGas),
      maxPriorityFeePerGas: toHex(input.maxPriorityFeePerGas),
      signature: DUMMY_SIGNATURE,
    };

    const setupQuote = await input.client.getPaymasterData(
      draftSetupUserOp,
      input.entryPoint,
      input.chain,
    );

    const setupHash = getUserOperationHash({
      userOperation: {
        sender: counterfactualAddress,
        nonce: input.nonce,
        factory: input.factoryAddress,
        factoryData,
        callData: setupCallData,
        callGasLimit: BigInt(setupQuote.callGasLimit),
        verificationGasLimit: BigInt(setupQuote.verificationGasLimit),
        preVerificationGas: BigInt(setupQuote.preVerificationGas),
        maxFeePerGas: input.maxFeePerGas,
        maxPriorityFeePerGas: input.maxPriorityFeePerGas,
        paymaster: setupQuote.paymaster,
        paymasterData: setupQuote.paymasterData,
        paymasterVerificationGasLimit: BigInt(setupQuote.paymasterVerificationGasLimit),
        paymasterPostOpGasLimit: BigInt(setupQuote.paymasterPostOpGasLimit),
        signature: DUMMY_SIGNATURE,
      },
      entryPointAddress: input.entryPoint,
      entryPointVersion: "0.7",
      chainId,
    });

    const setupSignature = await input.owner.signMessage({ message: { raw: setupHash } });

    setupUserOperationHash = await input.client.sendUserOperation(
      {
        ...draftSetupUserOp,
        callGasLimit: setupQuote.callGasLimit,
        verificationGasLimit: setupQuote.verificationGasLimit,
        preVerificationGas: setupQuote.preVerificationGas,
        paymasterVerificationGasLimit: setupQuote.paymasterVerificationGasLimit,
        paymasterPostOpGasLimit: setupQuote.paymasterPostOpGasLimit,
        paymasterAndData: setupQuote.paymasterAndData,
        signature: setupSignature,
      },
      input.entryPoint,
    );

    // Action op runs after bootstrap: account is now deployed, nonce is bumped.
    actionInitCode = "0x";
    actionNonce = input.nonce + 1n;
  }

  // 5. Action UserOp. Re-quote with the (possibly updated) nonce + initCode.
  const actionDraftUserOp = {
    ...draftActionUserOp,
    nonce: toHex(actionNonce),
    initCode: actionInitCode,
  };

  const actionQuote = await input.client.getPaymasterData(
    actionDraftUserOp,
    input.entryPoint,
    input.chain,
  );

  const actionHash = getUserOperationHash({
    userOperation: {
      sender: counterfactualAddress,
      nonce: actionNonce,
      ...(actionInitCode === "0x" ? {} : { factory: input.factoryAddress, factoryData }),
      callData: draftActionUserOp.callData as Hex,
      callGasLimit: BigInt(actionQuote.callGasLimit),
      verificationGasLimit: BigInt(actionQuote.verificationGasLimit),
      preVerificationGas: BigInt(actionQuote.preVerificationGas),
      maxFeePerGas: input.maxFeePerGas,
      maxPriorityFeePerGas: input.maxPriorityFeePerGas,
      paymaster: actionQuote.paymaster,
      paymasterData: actionQuote.paymasterData,
      paymasterVerificationGasLimit: BigInt(actionQuote.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: BigInt(actionQuote.paymasterPostOpGasLimit),
      signature: DUMMY_SIGNATURE,
    },
    entryPointAddress: input.entryPoint,
    entryPointVersion: "0.7",
    chainId,
  });

  const actionSignature = await input.owner.signMessage({ message: { raw: actionHash } });

  const submittedHash = await input.client.sendUserOperation(
    {
      ...actionDraftUserOp,
      callGasLimit: actionQuote.callGasLimit,
      verificationGasLimit: actionQuote.verificationGasLimit,
      preVerificationGas: actionQuote.preVerificationGas,
      paymasterVerificationGasLimit: actionQuote.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: actionQuote.paymasterPostOpGasLimit,
      paymasterAndData: actionQuote.paymasterAndData,
      signature: actionSignature,
    },
    input.entryPoint,
  );

  return {
    counterfactualAddress,
    quote: actionQuote,
    userOperationHash: submittedHash,
    ...(setupUserOperationHash !== undefined ? { setupUserOperationHash } : {}),
  };
};
