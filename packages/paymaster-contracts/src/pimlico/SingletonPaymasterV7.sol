// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PackedUserOperation} from "account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {_packValidationData} from "account-abstraction/contracts/core/Helpers.sol";
import {UserOperationLib} from "account-abstraction/contracts/core/UserOperationLib.sol";

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BaseSingletonPaymaster, ERC20PaymasterData, ERC20PostOpContext} from "./base/BaseSingletonPaymaster.sol";
import {IPaymasterV7} from "./interfaces/IPaymasterV7.sol";
import {PostOpMode} from "./interfaces/PostOpMode.sol";

using UserOperationLib for PackedUserOperation;

/// @title SingletonPaymasterV7
/// @author Pimlico (vendored from github.com/pimlicolabs/singleton-paymaster/blob/master/src/SingletonPaymasterV7.sol)
/// @notice ERC-4337 EntryPoint v0.7 paymaster supporting Verifying and ERC-20 modes.
/// @dev Vendored adaptations: pragma lowered to ^0.8.24, OZ 5.x SafeERC20 used in place of solady SafeTransferLib.
contract SingletonPaymasterV7 is BaseSingletonPaymaster, IPaymasterV7 {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------

    uint256 private immutable PAYMASTER_DATA_OFFSET = UserOperationLib.PAYMASTER_DATA_OFFSET;
    uint256 private immutable PAYMASTER_VALIDATION_GAS_OFFSET = UserOperationLib.PAYMASTER_VALIDATION_GAS_OFFSET;
    uint256 private constant PENALTY_PERCENT = 10;

    // -------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------

    constructor(
        address _entryPoint,
        address _owner,
        address _manager,
        address[] memory _signers
    ) BaseSingletonPaymaster(_entryPoint, _owner, _manager, _signers) {}

    // -------------------------------------------------------------
    // EntryPoint v0.7 overrides
    // -------------------------------------------------------------

    /// @inheritdoc IPaymasterV7
    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 requiredPreFund
    ) external override returns (bytes memory context, uint256 validationData) {
        _requireFromEntryPoint();
        return _validatePaymasterUserOp(userOp, userOpHash, requiredPreFund);
    }

    /// @inheritdoc IPaymasterV7
    function postOp(
        PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    ) external override {
        _requireFromEntryPoint();
        _postOp(mode, context, actualGasCost, actualUserOpFeePerGas);
    }

    /// @dev paymasterAndData for mode 0 (Verifying):
    ///  - paymaster address (20 bytes)
    ///  - paymaster verification gas (16 bytes)
    ///  - paymaster postop gas (16 bytes)
    ///  - mode and allowAllBundlers (1 byte): lowest bit = allowAllBundlers, rest = mode
    ///  - validUntil (6 bytes)
    ///  - validAfter (6 bytes)
    ///  - signature (64 or 65 bytes)
    ///
    /// @dev paymasterAndData for mode 1 (ERC-20):
    ///  - paymaster address (20 bytes)
    ///  - paymaster verification gas (16 bytes)
    ///  - paymaster postop gas (16 bytes)
    ///  - mode and allowAllBundlers (1 byte)
    ///  - flags (1 byte): 00000{preFundPresent}{recipientPresent}{constantFeePresent}
    ///  - validUntil (6 bytes)
    ///  - validAfter (6 bytes)
    ///  - token address (20 bytes)
    ///  - postOpGas (16 bytes)
    ///  - exchangeRate (32 bytes)
    ///  - paymasterValidationGasLimit (16 bytes)
    ///  - treasury (20 bytes)
    ///  - preFund (16 bytes, only if preFundPresent)
    ///  - constantFee (16 bytes, only if constantFeePresent)
    ///  - recipient (20 bytes, only if recipientPresent)
    ///  - signature (64 or 65 bytes)
    function _validatePaymasterUserOp(
        PackedUserOperation calldata _userOp,
        bytes32 _userOpHash,
        uint256 _requiredPreFund
    ) internal returns (bytes memory, uint256) {
        (uint8 mode, bool allowAllBundlers, bytes calldata paymasterConfig) =
            _parsePaymasterAndData(_userOp.paymasterAndData, PAYMASTER_DATA_OFFSET);

        if (!allowAllBundlers && !isBundlerAllowed[tx.origin]) {
            revert BundlerNotAllowed(tx.origin);
        }

        if (mode != ERC20_MODE && mode != VERIFYING_MODE) {
            revert PaymasterModeInvalid();
        }

        bytes memory context;
        uint256 validationData;

        if (mode == VERIFYING_MODE) {
            (context, validationData) = _validateVerifyingMode(_userOp, paymasterConfig, _userOpHash);
        }

        if (mode == ERC20_MODE) {
            (context, validationData) =
                _validateERC20Mode(mode, _userOp, paymasterConfig, _userOpHash, _requiredPreFund);
        }

        return (context, validationData);
    }

    function _validateVerifyingMode(
        PackedUserOperation calldata _userOp,
        bytes calldata _paymasterConfig,
        bytes32 _userOpHash
    ) internal returns (bytes memory, uint256) {
        (uint48 validUntil, uint48 validAfter, bytes calldata signature) = _parseVerifyingConfig(_paymasterConfig);

        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(getHash(VERIFYING_MODE, _userOp));
        address recoveredSigner = ECDSA.recover(hash, signature);

        bool isSignatureValid = signers[recoveredSigner];
        uint256 validationData = _packValidationData(!isSignatureValid, validUntil, validAfter);

        emit UserOperationSponsored(_userOpHash, _userOp.sender, VERIFYING_MODE, address(0), 0, 0);
        return ("", validationData);
    }

    function _validateERC20Mode(
        uint8 _mode,
        PackedUserOperation calldata _userOp,
        bytes calldata _paymasterConfig,
        bytes32 _userOpHash,
        uint256 _requiredPreFund
    ) internal returns (bytes memory, uint256) {
        ERC20PaymasterData memory cfg = _parseErc20Config(_paymasterConfig);

        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(getHash(_mode, _userOp));
        address recoveredSigner = ECDSA.recover(hash, cfg.signature);

        bool isSignatureValid = signers[recoveredSigner];
        uint256 validationData = _packValidationData(!isSignatureValid, cfg.validUntil, cfg.validAfter);
        bytes memory context = _createPostOpContext(_userOp, _userOpHash, cfg, _requiredPreFund);

        if (!isSignatureValid) {
            return (context, validationData);
        }

        uint256 costInToken = getCostInToken(_requiredPreFund, 0, 0, cfg.exchangeRate);

        if (cfg.preFundInToken > costInToken) {
            revert PreFundTooHigh();
        }

        if (cfg.preFundInToken > 0) {
            IERC20(cfg.token).safeTransferFrom(_userOp.sender, cfg.treasury, cfg.preFundInToken);
        }

        return (context, validationData);
    }

    function _expectedPenaltyGasCost(
        uint256 _actualGasCost,
        uint256 _actualUserOpFeePerGas,
        uint128 postOpGas,
        uint256 preOpGasApproximation,
        uint256 executionGasLimit
    ) public pure virtual returns (uint256) {
        uint256 executionGasUsed = 0;
        uint256 actualGas = _actualGasCost / _actualUserOpFeePerGas + postOpGas;

        if (actualGas > preOpGasApproximation) {
            executionGasUsed = actualGas - preOpGasApproximation;
        }

        uint256 expectedPenaltyGas = 0;
        if (executionGasLimit > executionGasUsed) {
            expectedPenaltyGas = ((executionGasLimit - executionGasUsed) * PENALTY_PERCENT) / 100;
        }

        return expectedPenaltyGas * _actualUserOpFeePerGas;
    }

    function _postOp(
        PostOpMode, /* mode */
        bytes calldata _context,
        uint256 _actualGasCost,
        uint256 _actualUserOpFeePerGas
    ) internal {
        ERC20PostOpContext memory ctx = _parsePostOpContext(_context);

        uint256 expectedPenaltyGasCost = _expectedPenaltyGasCost(
            _actualGasCost, _actualUserOpFeePerGas, ctx.postOpGas, ctx.preOpGasApproximation, ctx.executionGasLimit
        );

        uint256 actualGasCost = _actualGasCost + expectedPenaltyGasCost;

        uint256 costInToken =
            getCostInToken(actualGasCost, ctx.postOpGas, _actualUserOpFeePerGas, ctx.exchangeRate) + ctx.constantFee;

        uint256 absoluteCostInToken =
            costInToken > ctx.preFundCharged ? costInToken - ctx.preFundCharged : ctx.preFundCharged - costInToken;

        IERC20(ctx.token).safeTransferFrom(
            costInToken > ctx.preFundCharged ? ctx.sender : ctx.treasury,
            costInToken > ctx.preFundCharged ? ctx.treasury : ctx.sender,
            absoluteCostInToken
        );

        uint256 preFundInToken = (ctx.preFund * ctx.exchangeRate) / 1e18;

        if (ctx.recipient != address(0) && preFundInToken > costInToken) {
            IERC20(ctx.token).safeTransferFrom(ctx.sender, ctx.recipient, preFundInToken - costInToken);
        }

        emit UserOperationSponsored(ctx.userOpHash, ctx.sender, ERC20_MODE, ctx.token, costInToken, ctx.exchangeRate);
    }

    // -------------------------------------------------------------
    // Public helpers
    // -------------------------------------------------------------

    /// @notice Hash of the userOperation data that the signer should sign over.
    function getHash(uint8 _mode, PackedUserOperation calldata _userOp) public view virtual returns (bytes32) {
        if (_mode == VERIFYING_MODE) {
            return _getHash(_userOp, MODE_AND_ALLOW_ALL_BUNDLERS_LENGTH + VERIFYING_PAYMASTER_DATA_LENGTH);
        } else {
            uint8 paymasterDataLength = MODE_AND_ALLOW_ALL_BUNDLERS_LENGTH + ERC20_PAYMASTER_DATA_LENGTH;

            uint8 combinedByte =
                uint8(_userOp.paymasterAndData[PAYMASTER_DATA_OFFSET + MODE_AND_ALLOW_ALL_BUNDLERS_LENGTH]);
            bool constantFeePresent = (combinedByte & 0x01) != 0;
            bool recipientPresent = (combinedByte & 0x02) != 0;
            bool preFundPresent = (combinedByte & 0x04) != 0;

            if (preFundPresent) {
                paymasterDataLength += 16;
            }

            if (constantFeePresent) {
                paymasterDataLength += 16;
            }

            if (recipientPresent) {
                paymasterDataLength += 20;
            }

            return _getHash(_userOp, paymasterDataLength);
        }
    }

    function _getHash(
        PackedUserOperation calldata _userOp,
        uint256 paymasterDataLength
    ) internal view returns (bytes32) {
        bytes32 userOpHash = keccak256(
            abi.encode(
                _userOp.sender,
                _userOp.nonce,
                _userOp.accountGasLimits,
                _userOp.preVerificationGas,
                _userOp.gasFees,
                keccak256(_userOp.initCode),
                keccak256(_userOp.callData),
                keccak256(_userOp.paymasterAndData[:PAYMASTER_DATA_OFFSET + paymasterDataLength])
            )
        );

        return keccak256(abi.encode(userOpHash, block.chainid));
    }
}
