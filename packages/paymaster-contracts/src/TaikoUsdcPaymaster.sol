// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BasePaymaster} from "account-abstraction/contracts/core/BasePaymaster.sol";
import {IEntryPoint} from "account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {UserOperationLib} from "account-abstraction/contracts/core/UserOperationLib.sol";
import {_packValidationData} from "account-abstraction/contracts/core/Helpers.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IERC20 {
    function allowance(address owner, address spender) external view returns (uint256);

    function balanceOf(address account) external view returns (uint256);

    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

interface IUsdcPriceOracle {
    function quoteUsdcForWei(uint256 weiAmount) external view returns (uint256 usdcAmount);

    function usdcPerEth() external view returns (uint256 microsPerEth);
}

contract TaikoUsdcPaymaster is BasePaymaster, EIP712, ReentrancyGuard {
    using UserOperationLib for PackedUserOperation;

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

    struct PaymasterContext {
        address sender;
        bytes32 userOpHash;
        bytes32 quoteHash;
        uint256 prefund;
        uint256 oraclePrice;
    }

    uint256 private constant _MAX_BPS = 10_000;
    uint256 private constant _MAX_POST_OP_OVERHEAD_GAS = 1_000_000;

    bytes32 private constant _QUOTE_TYPEHASH =
        keccak256(
            "QuoteData(address sender,address token,address entryPoint,uint256 chainId,uint256 maxTokenCost,uint48 validAfter,uint48 validUntil,uint256 nonce,bytes32 callDataHash)"
        );

    error PaymasterPaused();
    error InvalidPaymasterData();
    error InvalidQuoteSender();
    error InvalidQuoteToken();
    error InvalidQuoteEntryPoint();
    error InvalidQuoteChain();
    error InvalidQuoteCallData();
    error QuoteExpired();
    error QuoteTtlTooLong();
    error QuoteAlreadyUsed();
    error InvalidQuoteSignature();
    error GasLimitTooHigh();
    error MaxCostExceeded();
    error InsufficientAllowance();
    error InsufficientBalance();
    error InvalidAddress();
    error InvalidBps();
    error InvalidLimits();
    error TokenTransferFailed();
    error NonceAlreadyUsed();
    error InsufficientUnlockedBalance();

    event UserOperationSponsored(
        address indexed token,
        address indexed sender,
        bytes32 indexed userOpHash,
        uint256 nativeTokenPriceMicros,
        uint256 actualTokenNeeded,
        uint256 feeTokenAmount,
        uint256 refundAmount
    );

    event QuoteSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event OracleUpdated(address indexed previousOracle, address indexed newOracle);
    event SurchargeBpsUpdated(uint256 previousBps, uint256 newBps);
    event LimitsUpdated(
        uint256 maxVerificationGasLimit,
        uint256 maxPostOpOverheadGas,
        uint256 maxNativeCostWei,
        uint256 maxQuoteTtlSeconds
    );
    event PausedSet(bool paused);

    IERC20 public immutable usdc;

    address public quoteSigner;
    IUsdcPriceOracle public priceOracle;

    uint256 public surchargeBps;
    uint256 public maxVerificationGasLimit;
    uint256 public postOpOverheadGas;
    uint256 public maxNativeCostWei;
    uint256 public maxQuoteTtlSeconds;
    bool public paused;

    mapping(bytes32 => bool) public usedQuoteHashes;

    uint256 public lockedUsdcPrefund;
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    modifier whenNotPaused() {
        if (paused) {
            revert PaymasterPaused();
        }
        _;
    }

    constructor(
        IEntryPoint entryPoint_,
        address usdc_,
        address quoteSigner_,
        address priceOracle_,
        uint256 surchargeBps_,
        uint256 maxVerificationGasLimit_,
        uint256 postOpOverheadGas_,
        uint256 maxNativeCostWei_,
        uint256 maxQuoteTtlSeconds_
    ) BasePaymaster(entryPoint_) EIP712("TaikoUsdcPaymaster", "1") {
        if (usdc_ == address(0) || quoteSigner_ == address(0) || priceOracle_ == address(0)) {
            revert InvalidAddress();
        }
        if (surchargeBps_ > _MAX_BPS) {
            revert InvalidBps();
        }
        _validateLimits(maxVerificationGasLimit_, postOpOverheadGas_, maxNativeCostWei_, maxQuoteTtlSeconds_);

        usdc = IERC20(usdc_);
        quoteSigner = quoteSigner_;
        priceOracle = IUsdcPriceOracle(priceOracle_);
        surchargeBps = surchargeBps_;
        maxVerificationGasLimit = maxVerificationGasLimit_;
        postOpOverheadGas = postOpOverheadGas_;
        maxNativeCostWei = maxNativeCostWei_;
        maxQuoteTtlSeconds = maxQuoteTtlSeconds_;
    }

    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) internal override whenNotPaused nonReentrant returns (bytes memory context, uint256 validationData) {
        if (userOp.unpackVerificationGasLimit() > maxVerificationGasLimit) {
            revert GasLimitTooHigh();
        }
        if (maxCost > maxNativeCostWei) {
            revert MaxCostExceeded();
        }
        if (userOp.paymasterAndData.length <= PAYMASTER_DATA_OFFSET) {
            revert InvalidPaymasterData();
        }

        bytes calldata paymasterData = userOp.paymasterAndData[PAYMASTER_DATA_OFFSET:];
        (QuoteData memory quote, bytes memory quoteSignature, PermitData memory permitData) =
            abi.decode(paymasterData, (QuoteData, bytes, PermitData));

        _validateQuote(userOp, quote);

        if (usedNonces[userOp.sender][quote.nonce]) {
            revert NonceAlreadyUsed();
        }

        bytes32 signedQuoteHash = _hashTypedDataV4(_hashQuote(quote));

        if (usedQuoteHashes[signedQuoteHash]) {
            revert QuoteAlreadyUsed();
        }

        address recovered = ECDSA.recover(signedQuoteHash, quoteSignature);
        if (recovered != quoteSigner) {
            revert InvalidQuoteSignature();
        }

        uint256 cachedOraclePrice = priceOracle.usdcPerEth();
        uint256 requiredPrefund = _applySurcharge((maxCost * cachedOraclePrice) / 1e18);
        if (requiredPrefund > quote.maxTokenCost) {
            revert MaxCostExceeded();
        }

        if (usdc.allowance(userOp.sender, address(this)) < quote.maxTokenCost) {
            if (permitData.value > 0) {
                try IERC20Permit(address(usdc)).permit(
                    userOp.sender,
                    address(this),
                    permitData.value,
                    permitData.deadline,
                    permitData.v,
                    permitData.r,
                    permitData.s
                ) {} catch {}
            }

            if (usdc.allowance(userOp.sender, address(this)) < quote.maxTokenCost) {
                revert InsufficientAllowance();
            }
        }

        if (usdc.balanceOf(userOp.sender) < quote.maxTokenCost) {
            revert InsufficientBalance();
        }

        usedQuoteHashes[signedQuoteHash] = true;
        usedNonces[userOp.sender][quote.nonce] = true;

        _safeTransferFrom(address(usdc), userOp.sender, address(this), quote.maxTokenCost);
        lockedUsdcPrefund += quote.maxTokenCost;

        context = abi.encode(
            PaymasterContext({
                sender: userOp.sender,
                userOpHash: userOpHash,
                quoteHash: signedQuoteHash,
                prefund: quote.maxTokenCost,
                oraclePrice: cachedOraclePrice
            })
        );
        validationData = _packValidationData(false, quote.validUntil, quote.validAfter);
    }

    function _postOp(
        PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    ) internal override whenNotPaused nonReentrant {
        PaymasterContext memory ctx = abi.decode(context, (PaymasterContext));

        uint256 nativeCostWithOverhead = actualGasCost + (actualUserOpFeePerGas * postOpOverheadGas);
        uint256 actualTokenNeeded = _applySurcharge((nativeCostWithOverhead * ctx.oraclePrice) / 1e18);

        uint256 feeTokenAmount = ctx.prefund;
        uint256 refundAmount;

        if (mode == PostOpMode.opSucceeded) {
            if (actualTokenNeeded < ctx.prefund) {
                refundAmount = ctx.prefund - actualTokenNeeded;
                feeTokenAmount = actualTokenNeeded;
                if (refundAmount > 0) {
                    _safeTransfer(address(usdc), ctx.sender, refundAmount);
                }
            } else if (actualTokenNeeded > ctx.prefund) {
                uint256 shortfall = actualTokenNeeded - ctx.prefund;
                _safeTransferFrom(address(usdc), ctx.sender, address(this), shortfall);
                feeTokenAmount = ctx.prefund + shortfall;
            }
        } else if (mode == PostOpMode.opReverted) {
            if (actualTokenNeeded < ctx.prefund) {
                refundAmount = ctx.prefund - actualTokenNeeded;
                feeTokenAmount = actualTokenNeeded;
                if (refundAmount > 0) {
                    _safeTransfer(address(usdc), ctx.sender, refundAmount);
                }
            }
        }
        // PostOpMode.postOpReverted: keep full prefund, no transfers

        lockedUsdcPrefund -= ctx.prefund;

        emit UserOperationSponsored(
            address(usdc),
            ctx.sender,
            ctx.userOpHash,
            ctx.oraclePrice,
            actualTokenNeeded,
            feeTokenAmount,
            refundAmount
        );
    }

    // ─── Admin ─────────────────────────────────────────────────

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function setQuoteSigner(address signer) external onlyOwner {
        if (signer == address(0)) {
            revert InvalidAddress();
        }

        address previous = quoteSigner;
        quoteSigner = signer;

        emit QuoteSignerUpdated(previous, signer);
    }

    function setPriceOracle(address oracle) external onlyOwner {
        if (oracle == address(0)) {
            revert InvalidAddress();
        }

        address previous = address(priceOracle);
        priceOracle = IUsdcPriceOracle(oracle);

        emit OracleUpdated(previous, oracle);
    }

    function setSurchargeBps(uint256 newSurchargeBps) external onlyOwner {
        if (newSurchargeBps > _MAX_BPS) {
            revert InvalidBps();
        }

        uint256 previous = surchargeBps;
        surchargeBps = newSurchargeBps;

        emit SurchargeBpsUpdated(previous, newSurchargeBps);
    }

    function setLimits(
        uint256 maxVerificationGasLimit_,
        uint256 postOpOverheadGas_,
        uint256 maxNativeCostWei_,
        uint256 maxQuoteTtlSeconds_
    ) external onlyOwner {
        _validateLimits(maxVerificationGasLimit_, postOpOverheadGas_, maxNativeCostWei_, maxQuoteTtlSeconds_);

        maxVerificationGasLimit = maxVerificationGasLimit_;
        postOpOverheadGas = postOpOverheadGas_;
        maxNativeCostWei = maxNativeCostWei_;
        maxQuoteTtlSeconds = maxQuoteTtlSeconds_;

        emit LimitsUpdated(maxVerificationGasLimit_, postOpOverheadGas_, maxNativeCostWei_, maxQuoteTtlSeconds_);
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(usdc)) {
            uint256 available = usdc.balanceOf(address(this)) - lockedUsdcPrefund;
            if (amount > available) {
                revert InsufficientUnlockedBalance();
            }
        }
        _safeTransfer(token, to, amount);
    }

    function quoteHash(QuoteData calldata quote) external view returns (bytes32) {
        return _hashTypedDataV4(_hashQuote(quote));
    }

    // ─── Internal ──────────────────────────────────────────────

    function _validateQuote(PackedUserOperation calldata userOp, QuoteData memory quote) private view {
        if (quote.sender != userOp.sender) {
            revert InvalidQuoteSender();
        }
        if (quote.token != address(usdc)) {
            revert InvalidQuoteToken();
        }
        if (quote.entryPoint != address(entryPoint)) {
            revert InvalidQuoteEntryPoint();
        }
        if (quote.chainId != block.chainid) {
            revert InvalidQuoteChain();
        }
        if (quote.callDataHash != keccak256(userOp.callData)) {
            revert InvalidQuoteCallData();
        }
        if (quote.validAfter > block.timestamp || quote.validUntil < block.timestamp || quote.validUntil < quote.validAfter) {
            revert QuoteExpired();
        }
        if (quote.validUntil > block.timestamp + maxQuoteTtlSeconds) {
            revert QuoteTtlTooLong();
        }
    }

    function _hashQuote(QuoteData memory quote) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                _QUOTE_TYPEHASH,
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

    function _applySurcharge(uint256 amount) private view returns (uint256) {
        if (amount == 0) {
            return 0;
        }

        return ((amount * (_MAX_BPS + surchargeBps)) + (_MAX_BPS - 1)) / _MAX_BPS;
    }

    function _validateLimits(
        uint256 maxVerificationGasLimit_,
        uint256 postOpOverheadGas_,
        uint256 maxNativeCostWei_,
        uint256 maxQuoteTtlSeconds_
    ) private pure {
        if (
            maxVerificationGasLimit_ == 0 ||
            postOpOverheadGas_ > _MAX_POST_OP_OVERHEAD_GAS ||
            maxNativeCostWei_ == 0 ||
            maxQuoteTtlSeconds_ == 0
        ) {
            revert InvalidLimits();
        }
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert TokenTransferFailed();
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert TokenTransferFailed();
        }
    }
}
