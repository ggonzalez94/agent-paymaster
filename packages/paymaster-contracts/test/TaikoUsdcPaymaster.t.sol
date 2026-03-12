// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TaikoUsdcPaymaster} from "../src/TaikoUsdcPaymaster.sol";
import {IPaymaster} from "account-abstraction/contracts/interfaces/IPaymaster.sol";
import {IEntryPoint} from "account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MockEntryPoint} from "./mocks/MockEntryPoint.sol";
import {MockERC20Permit} from "./mocks/MockERC20Permit.sol";
import {MockUsdcPriceOracle} from "./mocks/MockUsdcPriceOracle.sol";

contract TaikoUsdcPaymasterTest is Test {
    MockEntryPoint entryPoint;
    MockERC20Permit usdc;
    MockUsdcPriceOracle oracle;
    TaikoUsdcPaymaster paymaster;

    address owner;
    uint256 quoteSignerKey;
    address quoteSigner;
    address sender;
    address receiver;
    address other;

    bytes32 constant USER_OP_HASH = keccak256("user-operation-hash");

    bytes32 constant QUOTE_TYPEHASH = keccak256(
        "QuoteData(address sender,address token,address entryPoint,uint256 chainId,uint256 maxTokenCost,uint48 validAfter,uint48 validUntil,uint256 nonce,bytes32 callDataHash)"
    );
    bytes32 constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant NAME_HASH = keccak256("TaikoUsdcPaymaster");
    bytes32 constant VERSION_HASH = keccak256("1");

    string constant QUOTE_TUPLE_TYPE =
        "tuple(address sender,address token,address entryPoint,uint256 chainId,uint256 maxTokenCost,uint48 validAfter,uint48 validUntil,uint256 nonce,bytes32 callDataHash)";
    string constant PERMIT_TUPLE_TYPE = "tuple(uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)";

    // Default gas values for PackedUserOperation
    uint256 constant DEFAULT_CALL_GAS_LIMIT = 120_000;
    uint256 constant DEFAULT_PRE_VERIFICATION_GAS = 30_000;
    uint256 constant DEFAULT_MAX_FEE_PER_GAS = 1_000_000_000;
    uint256 constant DEFAULT_MAX_PRIORITY_FEE_PER_GAS = 1_000_000_000;
    uint128 constant DEFAULT_PAYMASTER_VALIDATION_GAS = 100_000;
    uint128 constant DEFAULT_PAYMASTER_POSTOP_GAS = 100_000;

    struct QuoteData {
        address sender;
        address token;
        address entryPoint;
        uint256 chainId;
        uint256 maxTokenCost;
        uint48 validAfter;
        uint48 validUntil;
        uint256 nonce;
        bytes32 callDataHash;
    }

    struct PermitData {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    function setUp() public {
        owner = address(this);
        quoteSignerKey = 0xA11CE;
        quoteSigner = vm.addr(quoteSignerKey);
        sender = makeAddr("sender");
        receiver = makeAddr("receiver");
        other = makeAddr("other");

        entryPoint = new MockEntryPoint();
        usdc = new MockERC20Permit();
        oracle = new MockUsdcPriceOracle(1_000_000);

        paymaster = new TaikoUsdcPaymaster(
            IEntryPoint(address(entryPoint)),
            address(usdc),
            quoteSigner,
            address(oracle),
            0, // surchargeBps
            200_000, // maxVerificationGasLimit
            0, // postOpOverheadGas
            0.01 ether, // maxNativeCostWei
            120 // maxQuoteTtlSeconds
        );

        usdc.mint(sender, 100_000_000);
    }

    // ─── Helpers ──────────────────────────────────────────────

    function _packAccountGasLimits(uint256 verificationGasLimit, uint256 callGasLimit) internal pure returns (bytes32) {
        return bytes32(verificationGasLimit << 128 | callGasLimit);
    }

    function _packGasFees(uint256 maxPriorityFeePerGas, uint256 maxFeePerGas) internal pure returns (bytes32) {
        return bytes32(maxPriorityFeePerGas << 128 | maxFeePerGas);
    }

    function _hashQuote(QuoteData memory quote) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                QUOTE_TYPEHASH,
                quote.sender,
                quote.token,
                quote.entryPoint,
                quote.chainId,
                quote.maxTokenCost,
                quote.validAfter,
                quote.validUntil,
                quote.nonce,
                quote.callDataHash
            )
        );
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(paymaster)));
    }

    function _hashTypedDataV4(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _signQuote(QuoteData memory quote) internal view returns (bytes memory) {
        bytes32 digest = _hashTypedDataV4(_hashQuote(quote));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(quoteSignerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _emptyPermit() internal pure returns (PermitData memory) {
        return PermitData({value: 0, deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)});
    }

    function _buildUserOp(
        address sender_,
        bytes memory callData_,
        uint256 maxTokenCost_,
        uint256 nonce_,
        uint256 verificationGasLimit_,
        PermitData memory permit_
    ) internal view returns (PackedUserOperation memory userOp, QuoteData memory quote) {
        uint48 now_ = uint48(block.timestamp);

        quote = QuoteData({
            sender: sender_,
            token: address(usdc),
            entryPoint: address(entryPoint),
            chainId: block.chainid,
            maxTokenCost: maxTokenCost_,
            validAfter: now_,
            validUntil: now_ + 90,
            nonce: nonce_,
            callDataHash: keccak256(callData_)
        });

        bytes memory sig = _signQuote(quote);

        bytes memory paymasterData = abi.encode(quote, sig, permit_);

        userOp = PackedUserOperation({
            sender: sender_,
            nonce: 1,
            initCode: "",
            callData: callData_,
            accountGasLimits: _packAccountGasLimits(verificationGasLimit_, DEFAULT_CALL_GAS_LIMIT),
            preVerificationGas: DEFAULT_PRE_VERIFICATION_GAS,
            gasFees: _packGasFees(DEFAULT_MAX_PRIORITY_FEE_PER_GAS, DEFAULT_MAX_FEE_PER_GAS),
            paymasterAndData: abi.encodePacked(
                address(paymaster),
                DEFAULT_PAYMASTER_VALIDATION_GAS,
                DEFAULT_PAYMASTER_POSTOP_GAS,
                paymasterData
            ),
            signature: ""
        });
    }

    function _buildUserOpSimple(address sender_, bytes memory callData_, uint256 maxTokenCost_, uint256 nonce_)
        internal
        view
        returns (PackedUserOperation memory, QuoteData memory)
    {
        return _buildUserOp(sender_, callData_, maxTokenCost_, nonce_, 120_000, _emptyPermit());
    }

    // ─── Tests ────────────────────────────────────────────────

    function test_rejectsValidateFromNonEntrypoint() public {
        PackedUserOperation memory userOp = PackedUserOperation({
            sender: sender,
            nonce: 1,
            initCode: "",
            callData: hex"1234",
            accountGasLimits: _packAccountGasLimits(100_000, 100_000),
            preVerificationGas: 20_000,
            gasFees: _packGasFees(1, 1),
            paymasterAndData: "",
            signature: ""
        });

        vm.prank(sender);
        vm.expectRevert("Sender not EntryPoint");
        paymaster.validatePaymasterUserOp(userOp, USER_OP_HASH, 1);
    }

    function test_locksPrefundAndMarksQuoteAsUsed() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp, QuoteData memory quote) =
            _buildUserOpSimple(sender, hex"123456", maxTokenCost, 7);

        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        assertEq(usdc.balanceOf(address(paymaster)), maxTokenCost);

        bytes32 qHash = paymaster.quoteHash(
            TaikoUsdcPaymaster.QuoteData({
                sender: quote.sender,
                token: quote.token,
                entryPoint: quote.entryPoint,
                chainId: quote.chainId,
                maxTokenCost: quote.maxTokenCost,
                validAfter: quote.validAfter,
                validUntil: quote.validUntil,
                nonce: quote.nonce,
                callDataHash: quote.callDataHash
            })
        );
        assertTrue(paymaster.usedQuoteHashes(qHash));
    }

    function test_rejectsQuoteReplay() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost * 2);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"abcd", maxTokenCost, 11);

        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        vm.expectRevert(TaikoUsdcPaymaster.NonceAlreadyUsed.selector);
        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);
    }

    function test_usesPermitWhenAllowanceMissing() public {
        uint256 maxTokenCost = 2_500_000;
        uint256 deadline = block.timestamp + 300;

        PermitData memory permit =
            PermitData({value: maxTokenCost, deadline: deadline, v: 27, r: bytes32(0), s: bytes32(0)});

        (PackedUserOperation memory userOp,) = _buildUserOp(sender, hex"55aa", maxTokenCost, 21, 120_000, permit);

        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        assertEq(usdc.balanceOf(address(paymaster)), maxTokenCost);
    }

    function test_fallsBackToAllowanceWhenPermitFails() public {
        uint256 maxTokenCost = 2_500_000;
        uint256 expiredDeadline = block.timestamp - 1;

        PermitData memory permit =
            PermitData({value: maxTokenCost, deadline: expiredDeadline, v: 27, r: bytes32(0), s: bytes32(0)});

        (PackedUserOperation memory userOp,) = _buildUserOp(sender, hex"90ab", maxTokenCost, 22, 120_000, permit);

        vm.expectRevert(TaikoUsdcPaymaster.InsufficientAllowance.selector);
        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);
    }

    function test_refundsExcessUsdcInPostOp() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"6677", maxTokenCost, 31);

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        assertEq(usdc.balanceOf(address(paymaster)), maxTokenCost);

        uint256 actualGasCost = 0.0004 ether;

        vm.expectEmit(true, true, true, true);
        emit TaikoUsdcPaymaster.UserOperationSponsored(
            address(usdc), sender, USER_OP_HASH, 1_000_000, 400, 400, 2_999_600
        );

        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.opSucceeded, context, actualGasCost, 0);

        assertEq(usdc.balanceOf(address(paymaster)), 400);
    }

    function test_pullsAdditionalUsdcOnShortfall() public {
        uint256 maxTokenCost = 1_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), 5_000_000);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"7788", maxTokenCost, 32);

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        vm.expectEmit(true, true, true, true);
        emit TaikoUsdcPaymaster.UserOperationSponsored(
            address(usdc), sender, USER_OP_HASH, 1_000_000, 2_000_000, 2_000_000, 0
        );

        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.opSucceeded, context, 2 ether, 0);

        assertEq(usdc.balanceOf(address(paymaster)), 2_000_000);
    }

    function test_capsChargesAtPrefundOnOpReverted() public {
        uint256 maxTokenCost = 1_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), 5_000_000);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"8899", maxTokenCost, 33);

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        vm.expectEmit(true, true, true, true);
        emit TaikoUsdcPaymaster.UserOperationSponsored(
            address(usdc), sender, USER_OP_HASH, 1_000_000, 2_000_000, 1_000_000, 0
        );

        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.opReverted, context, 2 ether, 0);

        assertEq(usdc.balanceOf(address(paymaster)), 1_000_000);
    }

    function test_skipsRefundOnPostOpReverted() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"9911", maxTokenCost, 34);

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        vm.expectEmit(true, true, true, true);
        emit TaikoUsdcPaymaster.UserOperationSponsored(
            address(usdc), sender, USER_OP_HASH, 1_000_000, 400, 3_000_000, 0
        );

        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.postOpReverted, context, 0.0004 ether, 0);

        assertEq(usdc.balanceOf(address(paymaster)), 3_000_000);
    }

    function test_rejectsValidateAndPostOpWhilePaused() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"aabb", maxTokenCost, 35);

        paymaster.setPaused(true);

        vm.expectRevert(TaikoUsdcPaymaster.PaymasterPaused.selector);
        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        paymaster.setPaused(false);

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        paymaster.setPaused(true);

        vm.expectRevert(TaikoUsdcPaymaster.PaymasterPaused.selector);
        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.opSucceeded, context, 0.0004 ether, 0);
    }

    function test_enforcesGasBounds() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) =
            _buildUserOp(sender, hex"beef", maxTokenCost, 41, 300_000, _emptyPermit());

        vm.expectRevert(TaikoUsdcPaymaster.GasLimitTooHigh.selector);
        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);
    }

    function test_ownerEntryPointDepositAndStake() public {
        vm.deal(address(this), 1 ether);

        // deposit() is public in BasePaymaster (anyone can fund the paymaster)
        paymaster.deposit{value: 0.02 ether}();
        assertEq(entryPoint.deposits(address(paymaster)), 0.02 ether);

        // withdrawTo is onlyOwner
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other));
        paymaster.withdrawTo(payable(receiver), 0.005 ether);

        paymaster.withdrawTo(payable(receiver), 0.005 ether);
        assertEq(entryPoint.deposits(address(paymaster)), 0.015 ether);

        paymaster.addStake{value: 0.01 ether}(1);
        assertEq(entryPoint.stakes(address(paymaster)), 0.01 ether);

        paymaster.withdrawStake(payable(receiver));
        assertEq(entryPoint.stakes(address(paymaster)), 0);
    }

    function test_ownerControlsAndLimitsValidation() public {
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other));
        paymaster.transferOwnership(other);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        paymaster.transferOwnership(address(0));

        paymaster.transferOwnership(other);
        assertEq(paymaster.owner(), other);

        // Owner changed to `other`, so `owner` (this) should fail
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        paymaster.setSurchargeBps(100);

        vm.prank(other);
        vm.expectRevert(TaikoUsdcPaymaster.InvalidBps.selector);
        paymaster.setSurchargeBps(10_001);

        vm.prank(other);
        paymaster.setSurchargeBps(100);
        assertEq(paymaster.surchargeBps(), 100);

        usdc.mint(address(paymaster), 50_000);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        paymaster.withdrawToken(address(usdc), receiver, 1);

        uint256 receiverBefore = usdc.balanceOf(receiver);
        vm.prank(other);
        paymaster.withdrawToken(address(usdc), receiver, 50_000);
        assertEq(usdc.balanceOf(receiver), receiverBefore + 50_000);

        vm.prank(other);
        vm.expectRevert(TaikoUsdcPaymaster.InvalidLimits.selector);
        paymaster.setLimits(0, 0, 1, 1);

        vm.prank(other);
        vm.expectRevert(TaikoUsdcPaymaster.InvalidLimits.selector);
        paymaster.setLimits(200_000, 1_000_001, 1, 1);

        vm.prank(other);
        vm.expectRevert(TaikoUsdcPaymaster.InvalidLimits.selector);
        paymaster.setLimits(200_000, 0, 1, 0);

        vm.prank(other);
        paymaster.setLimits(250_000, 50_000, 1 ether, 300);
        assertEq(paymaster.maxVerificationGasLimit(), 250_000);
        assertEq(paymaster.postOpOverheadGas(), 50_000);
        assertEq(paymaster.maxNativeCostWei(), 1 ether);
        assertEq(paymaster.maxQuoteTtlSeconds(), 300);
    }

    // ─── Security Fix Tests ──────────────────────────────────

    function test_I2_rejectsReuseOfSameNonce() public {
        vm.prank(sender);
        usdc.approve(address(paymaster), 10_000_000);

        (PackedUserOperation memory op1,) = _buildUserOpSimple(sender, hex"aa11", 3_000_000, 50);
        entryPoint.callValidatePaymaster(paymaster, op1, USER_OP_HASH, 0.001 ether);

        (PackedUserOperation memory op2,) = _buildUserOpSimple(sender, hex"bb22", 3_000_000, 50);

        vm.expectRevert(TaikoUsdcPaymaster.NonceAlreadyUsed.selector);
        entryPoint.callValidatePaymaster(paymaster, op2, USER_OP_HASH, 0.001 ether);
    }

    function test_I1_usesCachedOraclePriceInPostOp() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"cc33", maxTokenCost, 60);

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        // Change oracle price after validation
        oracle.setUsdcPerEth(2_000_000);

        vm.expectEmit(true, true, true, true);
        emit TaikoUsdcPaymaster.UserOperationSponsored(
            address(usdc),
            sender,
            USER_OP_HASH,
            1_000_000, // cached, not 2_000_000
            400,
            400,
            2_999_600
        );

        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.opSucceeded, context, 0.0004 ether, 0);
    }

    function test_C1_revertsPostOpOnShortfallPullFailure() public {
        uint256 maxTokenCost = 1_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"dd44", maxTokenCost, 70);

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        // Revoke remaining allowance
        vm.prank(sender);
        usdc.approve(address(paymaster), 0);

        vm.expectRevert(TaikoUsdcPaymaster.TokenTransferFailed.selector);
        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.opSucceeded, context, 2 ether, 0);
    }

    function test_I4_doesNotPullAdditionalOnOpReverted() public {
        uint256 maxTokenCost = 1_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), 5_000_000);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"ee55", maxTokenCost, 80);

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        vm.expectEmit(true, true, true, true);
        emit TaikoUsdcPaymaster.UserOperationSponsored(
            address(usdc),
            sender,
            USER_OP_HASH,
            1_000_000,
            2_000_000,
            1_000_000, // capped at prefund
            0
        );

        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.opReverted, context, 2 ether, 0);

        assertEq(usdc.balanceOf(address(paymaster)), 1_000_000);
    }

    function test_I5_preventsWithdrawOfLockedPrefund() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"ff66", maxTokenCost, 90);

        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        assertEq(paymaster.lockedUsdcPrefund(), maxTokenCost);

        vm.expectRevert(TaikoUsdcPaymaster.InsufficientUnlockedBalance.selector);
        paymaster.withdrawToken(address(usdc), receiver, maxTokenCost);

        // Mint extra to paymaster (simulates accumulated fees)
        usdc.mint(address(paymaster), 500_000);

        // Can withdraw the unlocked surplus
        paymaster.withdrawToken(address(usdc), receiver, 500_000);
        assertEq(usdc.balanceOf(receiver), 500_000);
    }

    function test_I5_unlocksPrefundAfterPostOp() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"1177", maxTokenCost, 91);

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        assertEq(paymaster.lockedUsdcPrefund(), maxTokenCost);

        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.opSucceeded, context, 0.0004 ether, 0);

        assertEq(paymaster.lockedUsdcPrefund(), 0);
    }
}
