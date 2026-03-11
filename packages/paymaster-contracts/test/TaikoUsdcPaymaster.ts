import { expect } from "chai";
import { ethers } from "hardhat";

const QUOTE_TYPES = {
  QuoteData: [
    { name: "sender", type: "address" },
    { name: "token", type: "address" },
    { name: "entryPoint", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "maxTokenCost", type: "uint256" },
    { name: "validAfter", type: "uint48" },
    { name: "validUntil", type: "uint48" },
    { name: "nonce", type: "uint256" },
    { name: "callDataHash", type: "bytes32" },
  ],
};

const QUOTE_TUPLE_TYPE =
  "tuple(address sender,address token,address entryPoint,uint256 chainId,uint256 maxTokenCost,uint48 validAfter,uint48 validUntil,uint256 nonce,bytes32 callDataHash)";
const PERMIT_TUPLE_TYPE =
  "tuple(uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)";

const USER_OP_HASH = ethers.keccak256(ethers.toUtf8Bytes("user-operation-hash"));

interface BuildUserOpParams {
  sender: string;
  callData: `0x${string}`;
  entryPoint: string;
  usdc: string;
  paymaster: string;
  chainId: bigint;
  quoteSigner: {
    signTypedData: (
      domain: Record<string, unknown>,
      types: Record<string, Array<{ name: string; type: string }>>,
      value: Record<string, unknown>,
    ) => Promise<string>;
  };
  nonce?: bigint;
  maxTokenCost?: bigint;
  validForSeconds?: number;
  permit?: {
    value: bigint;
    deadline: bigint;
    v: number;
    r: `0x${string}`;
    s: `0x${string}`;
  };
  verificationGasLimit?: bigint;
}

async function buildUserOperation(params: BuildUserOpParams) {
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const maxTokenCost = params.maxTokenCost ?? 3_000_000n;
  const validForSeconds = BigInt(params.validForSeconds ?? 90);

  const quote = {
    sender: params.sender,
    token: params.usdc,
    entryPoint: params.entryPoint,
    chainId: params.chainId,
    maxTokenCost,
    validAfter: now,
    validUntil: now + validForSeconds,
    nonce: params.nonce ?? 1n,
    callDataHash: ethers.keccak256(params.callData),
  };

  const domain = {
    name: "TaikoUsdcPaymaster",
    version: "1",
    chainId: params.chainId,
    verifyingContract: params.paymaster,
  };

  const signature = await params.quoteSigner.signTypedData(domain, QUOTE_TYPES, quote);

  const permit =
    params.permit ??
    ({
      value: 0n,
      deadline: 0n,
      v: 0,
      r: ethers.ZeroHash,
      s: ethers.ZeroHash,
    } as const);

  const paymasterData = ethers.AbiCoder.defaultAbiCoder().encode(
    [QUOTE_TUPLE_TYPE, "bytes", PERMIT_TUPLE_TYPE],
    [quote, signature, permit],
  );

  const userOperation = {
    sender: params.sender,
    nonce: 1n,
    initCode: "0x",
    callData: params.callData,
    callGasLimit: 120_000n,
    verificationGasLimit: params.verificationGasLimit ?? 120_000n,
    preVerificationGas: 30_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    paymasterAndData: `${params.paymaster}${paymasterData.slice(2)}`,
    signature: "0x",
  };

  return { userOperation, quote };
}

describe("TaikoUsdcPaymaster", () => {
  async function deployFixture() {
    const [owner, quoteSigner, sender, receiver, other] = await ethers.getSigners();

    const entryPointFactory = await ethers.getContractFactory("MockEntryPoint");
    const entryPoint = await entryPointFactory.deploy();
    await entryPoint.waitForDeployment();

    const usdcFactory = await ethers.getContractFactory("MockERC20Permit");
    const usdc = await usdcFactory.deploy();
    await usdc.waitForDeployment();

    const oracleFactory = await ethers.getContractFactory("MockUsdcPriceOracle");
    const oracle = await oracleFactory.deploy(1_000_000n);
    await oracle.waitForDeployment();

    const paymasterFactory = await ethers.getContractFactory("TaikoUsdcPaymaster");
    const paymaster = await paymasterFactory.deploy(
      owner.address,
      await entryPoint.getAddress(),
      await usdc.getAddress(),
      quoteSigner.address,
      await oracle.getAddress(),
      0,
      200_000,
      0,
      ethers.parseEther("0.01"),
      120,
    );
    await paymaster.waitForDeployment();

    await usdc.mint(sender.address, 100_000_000n);

    return {
      owner,
      quoteSigner,
      sender,
      receiver,
      other,
      entryPoint,
      usdc,
      oracle,
      paymaster,
      chainId: BigInt((await ethers.provider.getNetwork()).chainId),
    };
  }

  it("rejects validate calls from non-entrypoint", async () => {
    const { paymaster, sender } = await deployFixture();

    await expect(
      paymaster.connect(sender).validatePaymasterUserOp(
        {
          sender: sender.address,
          nonce: 1n,
          initCode: "0x",
          callData: "0x1234",
          callGasLimit: 100_000n,
          verificationGasLimit: 100_000n,
          preVerificationGas: 20_000n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
          paymasterAndData: "0x",
          signature: "0x",
        },
        USER_OP_HASH,
        1n,
      ),
    ).to.be.revertedWithCustomError(paymaster, "NotEntryPoint");
  });

  it("locks prefund during validation and marks quote as used", async () => {
    const { sender, quoteSigner, entryPoint, usdc, paymaster, chainId } = await deployFixture();

    const maxTokenCost = 3_000_000n;

    await usdc.connect(sender).approve(await paymaster.getAddress(), maxTokenCost);

    const { userOperation, quote } = await buildUserOperation({
      sender: sender.address,
      callData: "0x123456",
      entryPoint: await entryPoint.getAddress(),
      usdc: await usdc.getAddress(),
      paymaster: await paymaster.getAddress(),
      chainId,
      quoteSigner,
      maxTokenCost,
      nonce: 7n,
    });

    const [context] = await entryPoint.callValidatePaymaster.staticCall(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    expect(context).to.not.equal("0x");

    await entryPoint.callValidatePaymaster(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    expect(await usdc.balanceOf(await paymaster.getAddress())).to.equal(maxTokenCost);

    const quoteHash = await paymaster.quoteHash(quote);
    expect(await paymaster.usedQuoteHashes(quoteHash)).to.equal(true);
  });

  it("rejects quote replay", async () => {
    const { sender, quoteSigner, entryPoint, usdc, paymaster, chainId } = await deployFixture();

    const maxTokenCost = 3_000_000n;

    await usdc.connect(sender).approve(await paymaster.getAddress(), maxTokenCost * 2n);

    const { userOperation } = await buildUserOperation({
      sender: sender.address,
      callData: "0xabcd",
      entryPoint: await entryPoint.getAddress(),
      usdc: await usdc.getAddress(),
      paymaster: await paymaster.getAddress(),
      chainId,
      quoteSigner,
      maxTokenCost,
      nonce: 11n,
    });

    await entryPoint.callValidatePaymaster(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    await expect(
      entryPoint.callValidatePaymaster(
        await paymaster.getAddress(),
        userOperation,
        USER_OP_HASH,
        ethers.parseEther("0.001"),
      ),
    ).to.be.revertedWithCustomError(paymaster, "NonceAlreadyUsed");
  });

  it("uses permit data when allowance is missing", async () => {
    const { sender, quoteSigner, entryPoint, usdc, paymaster, chainId } = await deployFixture();

    const maxTokenCost = 2_500_000n;
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 300n;

    const { userOperation } = await buildUserOperation({
      sender: sender.address,
      callData: "0x55aa",
      entryPoint: await entryPoint.getAddress(),
      usdc: await usdc.getAddress(),
      paymaster: await paymaster.getAddress(),
      chainId,
      quoteSigner,
      maxTokenCost,
      nonce: 21n,
      permit: {
        value: maxTokenCost,
        deadline,
        v: 27,
        r: ethers.ZeroHash,
        s: ethers.ZeroHash,
      },
    });

    await entryPoint.callValidatePaymaster(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    expect(await usdc.balanceOf(await paymaster.getAddress())).to.equal(maxTokenCost);
  });

  it("falls back to allowance checks when permit validation fails", async () => {
    const { sender, quoteSigner, entryPoint, usdc, paymaster, chainId } = await deployFixture();

    const maxTokenCost = 2_500_000n;
    const expiredDeadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) - 1n;

    const { userOperation } = await buildUserOperation({
      sender: sender.address,
      callData: "0x90ab",
      entryPoint: await entryPoint.getAddress(),
      usdc: await usdc.getAddress(),
      paymaster: await paymaster.getAddress(),
      chainId,
      quoteSigner,
      maxTokenCost,
      nonce: 22n,
      permit: {
        value: maxTokenCost,
        deadline: expiredDeadline,
        v: 27,
        r: ethers.ZeroHash,
        s: ethers.ZeroHash,
      },
    });

    await expect(
      entryPoint.callValidatePaymaster(
        await paymaster.getAddress(),
        userOperation,
        USER_OP_HASH,
        ethers.parseEther("0.001"),
      ),
    ).to.be.revertedWithCustomError(paymaster, "InsufficientAllowance");
  });

  it("refunds excess USDC in postOp", async () => {
    const { sender, quoteSigner, entryPoint, usdc, paymaster, chainId } = await deployFixture();

    const maxTokenCost = 3_000_000n;

    await usdc.connect(sender).approve(await paymaster.getAddress(), maxTokenCost);

    const { userOperation } = await buildUserOperation({
      sender: sender.address,
      callData: "0x6677",
      entryPoint: await entryPoint.getAddress(),
      usdc: await usdc.getAddress(),
      paymaster: await paymaster.getAddress(),
      chainId,
      quoteSigner,
      maxTokenCost,
      nonce: 31n,
    });

    const [context] = await entryPoint.callValidatePaymaster.staticCall(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    await entryPoint.callValidatePaymaster(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    const balanceAfterPrefund = await usdc.balanceOf(await paymaster.getAddress());
    expect(balanceAfterPrefund).to.equal(maxTokenCost);

    const actualGasCost = ethers.parseEther("0.0004");

    await expect(
      entryPoint.callPostOp(await paymaster.getAddress(), 0, context, actualGasCost, 0),
    )
      .to.emit(paymaster, "UserOperationSponsored")
      .withArgs(await usdc.getAddress(), sender.address, USER_OP_HASH, 1_000_000n, 400n, 400n, 2_999_600n);

    expect(await usdc.balanceOf(await paymaster.getAddress())).to.equal(400n);
  });

  it("pulls additional USDC when postOp shortfall occurs on successful ops", async () => {
    const { sender, quoteSigner, entryPoint, usdc, paymaster, chainId } = await deployFixture();

    const maxTokenCost = 1_000_000n;

    await usdc.connect(sender).approve(await paymaster.getAddress(), 5_000_000n);

    const { userOperation } = await buildUserOperation({
      sender: sender.address,
      callData: "0x7788",
      entryPoint: await entryPoint.getAddress(),
      usdc: await usdc.getAddress(),
      paymaster: await paymaster.getAddress(),
      chainId,
      quoteSigner,
      maxTokenCost,
      nonce: 32n,
    });

    const [context] = await entryPoint.callValidatePaymaster.staticCall(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    await entryPoint.callValidatePaymaster(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    await expect(
      entryPoint.callPostOp(await paymaster.getAddress(), 0, context, ethers.parseEther("2"), 0),
    )
      .to.emit(paymaster, "UserOperationSponsored")
      .withArgs(await usdc.getAddress(), sender.address, USER_OP_HASH, 1_000_000n, 2_000_000n, 2_000_000n, 0n);

    expect(await usdc.balanceOf(await paymaster.getAddress())).to.equal(2_000_000n);
  });

  it("caps charges at prefund when user operation reverts", async () => {
    const { sender, quoteSigner, entryPoint, usdc, paymaster, chainId } = await deployFixture();

    const maxTokenCost = 1_000_000n;

    await usdc.connect(sender).approve(await paymaster.getAddress(), 5_000_000n);

    const { userOperation } = await buildUserOperation({
      sender: sender.address,
      callData: "0x8899",
      entryPoint: await entryPoint.getAddress(),
      usdc: await usdc.getAddress(),
      paymaster: await paymaster.getAddress(),
      chainId,
      quoteSigner,
      maxTokenCost,
      nonce: 33n,
    });

    const [context] = await entryPoint.callValidatePaymaster.staticCall(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    await entryPoint.callValidatePaymaster(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    await expect(
      entryPoint.callPostOp(await paymaster.getAddress(), 1, context, ethers.parseEther("2"), 0),
    )
      .to.emit(paymaster, "UserOperationSponsored")
      .withArgs(await usdc.getAddress(), sender.address, USER_OP_HASH, 1_000_000n, 2_000_000n, 1_000_000n, 0n);

    expect(await usdc.balanceOf(await paymaster.getAddress())).to.equal(1_000_000n);
  });

  it("skips refund and extra pulls when mode is postOpReverted", async () => {
    const { sender, quoteSigner, entryPoint, usdc, paymaster, chainId } = await deployFixture();

    const maxTokenCost = 3_000_000n;

    await usdc.connect(sender).approve(await paymaster.getAddress(), maxTokenCost);

    const { userOperation } = await buildUserOperation({
      sender: sender.address,
      callData: "0x9911",
      entryPoint: await entryPoint.getAddress(),
      usdc: await usdc.getAddress(),
      paymaster: await paymaster.getAddress(),
      chainId,
      quoteSigner,
      maxTokenCost,
      nonce: 34n,
    });

    const [context] = await entryPoint.callValidatePaymaster.staticCall(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    await entryPoint.callValidatePaymaster(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    await expect(
      entryPoint.callPostOp(await paymaster.getAddress(), 2, context, ethers.parseEther("0.0004"), 0),
    )
      .to.emit(paymaster, "UserOperationSponsored")
      .withArgs(await usdc.getAddress(), sender.address, USER_OP_HASH, 1_000_000n, 400n, 3_000_000n, 0n);

    expect(await usdc.balanceOf(await paymaster.getAddress())).to.equal(3_000_000n);
  });

  it("rejects validate and postOp while paused", async () => {
    const { owner, sender, quoteSigner, entryPoint, usdc, paymaster, chainId } = await deployFixture();

    await usdc.connect(sender).approve(await paymaster.getAddress(), 3_000_000n);

    const { userOperation } = await buildUserOperation({
      sender: sender.address,
      callData: "0xaabb",
      entryPoint: await entryPoint.getAddress(),
      usdc: await usdc.getAddress(),
      paymaster: await paymaster.getAddress(),
      chainId,
      quoteSigner,
      maxTokenCost: 3_000_000n,
      nonce: 35n,
    });

    await paymaster.connect(owner).setPaused(true);

    await expect(
      entryPoint.callValidatePaymaster(
        await paymaster.getAddress(),
        userOperation,
        USER_OP_HASH,
        ethers.parseEther("0.001"),
      ),
    ).to.be.revertedWithCustomError(paymaster, "PaymasterPaused");

    await paymaster.connect(owner).setPaused(false);

    const [context] = await entryPoint.callValidatePaymaster.staticCall(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    await entryPoint.callValidatePaymaster(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    await paymaster.connect(owner).setPaused(true);

    await expect(
      entryPoint.callPostOp(await paymaster.getAddress(), 0, context, ethers.parseEther("0.0004"), 0),
    ).to.be.revertedWithCustomError(paymaster, "PaymasterPaused");
  });

  it("enforces anti-griefing gas bounds", async () => {
    const { sender, quoteSigner, entryPoint, usdc, paymaster, chainId } = await deployFixture();

    await usdc.connect(sender).approve(await paymaster.getAddress(), 3_000_000n);

    const { userOperation } = await buildUserOperation({
      sender: sender.address,
      callData: "0xbeef",
      entryPoint: await entryPoint.getAddress(),
      usdc: await usdc.getAddress(),
      paymaster: await paymaster.getAddress(),
      chainId,
      quoteSigner,
      maxTokenCost: 3_000_000n,
      nonce: 41n,
      verificationGasLimit: 300_000n,
    });

    await expect(
      entryPoint.callValidatePaymaster(
        await paymaster.getAddress(),
        userOperation,
        USER_OP_HASH,
        ethers.parseEther("0.001"),
      ),
    ).to.be.revertedWithCustomError(paymaster, "GasLimitTooHigh");
  });

  it("supports owner-managed entrypoint deposit and stake controls", async () => {
    const { owner, other, entryPoint, paymaster, receiver } = await deployFixture();

    await expect(
      paymaster.connect(other).depositToEntryPoint({ value: ethers.parseEther("0.01") }),
    ).to.be.revertedWithCustomError(paymaster, "NotOwner");

    await paymaster.connect(owner).depositToEntryPoint({ value: ethers.parseEther("0.02") });

    expect(await entryPoint.deposits(await paymaster.getAddress())).to.equal(ethers.parseEther("0.02"));

    await paymaster.connect(owner).withdrawFromEntryPoint(receiver.address, ethers.parseEther("0.005"));

    expect(await entryPoint.deposits(await paymaster.getAddress())).to.equal(ethers.parseEther("0.015"));

    await paymaster.connect(owner).addStake(1, { value: ethers.parseEther("0.01") });

    expect(await entryPoint.stakes(await paymaster.getAddress())).to.equal(ethers.parseEther("0.01"));

    await paymaster.connect(owner).withdrawStake(receiver.address);

    expect(await entryPoint.stakes(await paymaster.getAddress())).to.equal(0n);
  });

  it("enforces owner controls and limits validation on admin methods", async () => {
    const { owner, other, receiver, usdc, paymaster } = await deployFixture();

    await expect(paymaster.connect(other).transferOwnership(other.address)).to.be.revertedWithCustomError(
      paymaster,
      "NotOwner",
    );

    await expect(paymaster.connect(owner).transferOwnership(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      paymaster,
      "InvalidAddress",
    );

    await paymaster.connect(owner).transferOwnership(other.address);
    expect(await paymaster.owner()).to.equal(other.address);

    await expect(paymaster.connect(owner).setSurchargeBps(100)).to.be.revertedWithCustomError(paymaster, "NotOwner");
    await expect(paymaster.connect(other).setSurchargeBps(10_001)).to.be.revertedWithCustomError(
      paymaster,
      "InvalidBps",
    );
    await paymaster.connect(other).setSurchargeBps(100);
    expect(await paymaster.surchargeBps()).to.equal(100n);

    await usdc.mint(await paymaster.getAddress(), 50_000n);

    await expect(
      paymaster.connect(owner).withdrawToken(await usdc.getAddress(), receiver.address, 1n),
    ).to.be.revertedWithCustomError(paymaster, "NotOwner");

    const receiverBefore = await usdc.balanceOf(receiver.address);
    await paymaster.connect(other).withdrawToken(await usdc.getAddress(), receiver.address, 50_000n);
    expect(await usdc.balanceOf(receiver.address)).to.equal(receiverBefore + 50_000n);

    await expect(paymaster.connect(other).setLimits(0, 0, 1n, 1n)).to.be.revertedWithCustomError(
      paymaster,
      "InvalidLimits",
    );
    await expect(paymaster.connect(other).setLimits(200_000n, 1_000_001n, 1n, 1n)).to.be.revertedWithCustomError(
      paymaster,
      "InvalidLimits",
    );
    await expect(paymaster.connect(other).setLimits(200_000n, 0, 1n, 0)).to.be.revertedWithCustomError(
      paymaster,
      "InvalidLimits",
    );

    await paymaster.connect(other).setLimits(250_000n, 50_000n, ethers.parseEther("1"), 300n);
    expect(await paymaster.maxVerificationGasLimit()).to.equal(250_000n);
    expect(await paymaster.postOpOverheadGas()).to.equal(50_000n);
    expect(await paymaster.maxNativeCostWei()).to.equal(ethers.parseEther("1"));
    expect(await paymaster.maxQuoteTtlSeconds()).to.equal(300n);
  });

  // --- Security fix tests ---

  it("[I-2] rejects reuse of same nonce across different quotes", async () => {
    const { sender, quoteSigner, entryPoint, usdc, paymaster, chainId } = await deployFixture();

    await usdc.connect(sender).approve(await paymaster.getAddress(), 10_000_000n);

    // First quote with nonce=50 succeeds
    const { userOperation: op1 } = await buildUserOperation({
      sender: sender.address,
      callData: "0xaa11",
      entryPoint: await entryPoint.getAddress(),
      usdc: await usdc.getAddress(),
      paymaster: await paymaster.getAddress(),
      chainId,
      quoteSigner,
      maxTokenCost: 3_000_000n,
      nonce: 50n,
    });

    await entryPoint.callValidatePaymaster(
      await paymaster.getAddress(),
      op1,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    // Second quote with same nonce=50 but different callData — must fail
    const { userOperation: op2 } = await buildUserOperation({
      sender: sender.address,
      callData: "0xbb22",
      entryPoint: await entryPoint.getAddress(),
      usdc: await usdc.getAddress(),
      paymaster: await paymaster.getAddress(),
      chainId,
      quoteSigner,
      maxTokenCost: 3_000_000n,
      nonce: 50n,
    });

    await expect(
      entryPoint.callValidatePaymaster(
        await paymaster.getAddress(),
        op2,
        USER_OP_HASH,
        ethers.parseEther("0.001"),
      ),
    ).to.be.revertedWithCustomError(paymaster, "NonceAlreadyUsed");
  });

  it("[I-1] uses cached oracle price in postOp, not live price", async () => {
    const { sender, quoteSigner, entryPoint, usdc, oracle, paymaster, chainId } = await deployFixture();

    const maxTokenCost = 3_000_000n;
    await usdc.connect(sender).approve(await paymaster.getAddress(), maxTokenCost);

    const { userOperation } = await buildUserOperation({
      sender: sender.address,
      callData: "0xcc33",
      entryPoint: await entryPoint.getAddress(),
      usdc: await usdc.getAddress(),
      paymaster: await paymaster.getAddress(),
      chainId,
      quoteSigner,
      maxTokenCost,
      nonce: 60n,
    });

    const [context] = await entryPoint.callValidatePaymaster.staticCall(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    await entryPoint.callValidatePaymaster(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    // Change oracle price after validation (simulates price manipulation)
    await oracle.setUsdcPerEth(2_000_000n); // doubled

    // postOp should use cached price (1_000_000), not live (2_000_000)
    const actualGasCost = ethers.parseEther("0.0004");
    await expect(
      entryPoint.callPostOp(await paymaster.getAddress(), 0, context, actualGasCost, 0),
    )
      .to.emit(paymaster, "UserOperationSponsored")
      .withArgs(
        await usdc.getAddress(),
        sender.address,
        USER_OP_HASH,
        1_000_000n, // cached oracle price, not 2_000_000
        400n, // 0.0004 ETH * 1_000_000 USDC/ETH = 400 micros
        400n,
        2_999_600n,
      );
  });

  it("[C-1] reverts postOp when shortfall pull fails due to revoked allowance", async () => {
    const { sender, quoteSigner, entryPoint, usdc, paymaster, chainId } = await deployFixture();

    const maxTokenCost = 1_000_000n;
    // Only approve maxTokenCost (no excess for shortfall pull)
    await usdc.connect(sender).approve(await paymaster.getAddress(), maxTokenCost);

    const { userOperation } = await buildUserOperation({
      sender: sender.address,
      callData: "0xdd44",
      entryPoint: await entryPoint.getAddress(),
      usdc: await usdc.getAddress(),
      paymaster: await paymaster.getAddress(),
      chainId,
      quoteSigner,
      maxTokenCost,
      nonce: 70n,
    });

    const [context] = await entryPoint.callValidatePaymaster.staticCall(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    await entryPoint.callValidatePaymaster(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    // Revoke remaining allowance
    await usdc.connect(sender).approve(await paymaster.getAddress(), 0n);

    // postOp with high gas cost (needs shortfall pull) should revert
    await expect(
      entryPoint.callPostOp(await paymaster.getAddress(), 0, context, ethers.parseEther("2"), 0),
    ).to.be.revertedWithCustomError(paymaster, "TokenTransferFailed");
  });

  it("[I-4] does not pull additional on opReverted, caps at prefund", async () => {
    const { sender, quoteSigner, entryPoint, usdc, paymaster, chainId } = await deployFixture();

    const maxTokenCost = 1_000_000n;
    await usdc.connect(sender).approve(await paymaster.getAddress(), 5_000_000n);

    const { userOperation } = await buildUserOperation({
      sender: sender.address,
      callData: "0xee55",
      entryPoint: await entryPoint.getAddress(),
      usdc: await usdc.getAddress(),
      paymaster: await paymaster.getAddress(),
      chainId,
      quoteSigner,
      maxTokenCost,
      nonce: 80n,
    });

    const [context] = await entryPoint.callValidatePaymaster.staticCall(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    await entryPoint.callValidatePaymaster(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    // opReverted with high gas — should NOT pull additional, just keep prefund
    await expect(
      entryPoint.callPostOp(await paymaster.getAddress(), 1, context, ethers.parseEther("2"), 0),
    )
      .to.emit(paymaster, "UserOperationSponsored")
      .withArgs(
        await usdc.getAddress(),
        sender.address,
        USER_OP_HASH,
        1_000_000n,
        2_000_000n,
        1_000_000n, // capped at prefund, no additional pull
        0n,
      );

    // Paymaster should only hold the original prefund, not more
    expect(await usdc.balanceOf(await paymaster.getAddress())).to.equal(1_000_000n);
  });

  it("[I-5] prevents withdrawToken from sweeping locked USDC prefund", async () => {
    const { owner, sender, quoteSigner, entryPoint, usdc, paymaster, chainId, receiver } =
      await deployFixture();

    const maxTokenCost = 3_000_000n;
    await usdc.connect(sender).approve(await paymaster.getAddress(), maxTokenCost);

    const { userOperation } = await buildUserOperation({
      sender: sender.address,
      callData: "0xff66",
      entryPoint: await entryPoint.getAddress(),
      usdc: await usdc.getAddress(),
      paymaster: await paymaster.getAddress(),
      chainId,
      quoteSigner,
      maxTokenCost,
      nonce: 90n,
    });

    // Validate locks the prefund
    await entryPoint.callValidatePaymaster(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    expect(await paymaster.lockedUsdcPrefund()).to.equal(maxTokenCost);

    // Owner cannot withdraw locked USDC
    await expect(
      paymaster.connect(owner).withdrawToken(await usdc.getAddress(), receiver.address, maxTokenCost),
    ).to.be.revertedWithCustomError(paymaster, "InsufficientUnlockedBalance");

    // Mint extra USDC directly to paymaster (simulates accumulated fees)
    await usdc.mint(await paymaster.getAddress(), 500_000n);

    // Owner can withdraw the unlocked surplus
    await paymaster.connect(owner).withdrawToken(await usdc.getAddress(), receiver.address, 500_000n);
    expect(await usdc.balanceOf(receiver.address)).to.equal(500_000n);
  });

  it("[I-5] unlocks prefund after postOp completes", async () => {
    const { sender, quoteSigner, entryPoint, usdc, paymaster, chainId } = await deployFixture();

    const maxTokenCost = 3_000_000n;
    await usdc.connect(sender).approve(await paymaster.getAddress(), maxTokenCost);

    const { userOperation } = await buildUserOperation({
      sender: sender.address,
      callData: "0x1177",
      entryPoint: await entryPoint.getAddress(),
      usdc: await usdc.getAddress(),
      paymaster: await paymaster.getAddress(),
      chainId,
      quoteSigner,
      maxTokenCost,
      nonce: 91n,
    });

    const [context] = await entryPoint.callValidatePaymaster.staticCall(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    await entryPoint.callValidatePaymaster(
      await paymaster.getAddress(),
      userOperation,
      USER_OP_HASH,
      ethers.parseEther("0.001"),
    );

    expect(await paymaster.lockedUsdcPrefund()).to.equal(maxTokenCost);

    // Complete the operation
    await entryPoint.callPostOp(await paymaster.getAddress(), 0, context, ethers.parseEther("0.0004"), 0);

    // Locked prefund should be zero after postOp
    expect(await paymaster.lockedUsdcPrefund()).to.equal(0n);
  });
});
