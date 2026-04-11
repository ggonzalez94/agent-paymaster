// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/* solhint-disable reason-string */

import {BasePaymaster} from "./BasePaymaster.sol";
import {MultiSigner} from "./MultiSigner.sol";

import {UserOperationLib} from "account-abstraction/contracts/core/UserOperationLib.sol";
import {PackedUserOperation} from "account-abstraction/contracts/interfaces/PackedUserOperation.sol";

import {ManagerAccessControl} from "./ManagerAccessControl.sol";

using UserOperationLib for PackedUserOperation;

/// @notice Holds all context needed during the EntryPoint's postOp call.
struct ERC20PostOpContext {
    address sender;
    address token;
    address treasury;
    uint256 exchangeRate;
    uint128 postOpGas;
    bytes32 userOpHash;
    uint256 maxFeePerGas;
    uint256 maxPriorityFeePerGas;
    uint256 preFund;
    uint256 preFundCharged;
    uint256 executionGasLimit;
    uint256 preOpGasApproximation;
    uint128 constantFee;
    address recipient;
}

/// @notice Hold all configs needed in ERC-20 mode.
struct ERC20PaymasterData {
    address treasury;
    uint48 validUntil;
    uint48 validAfter;
    uint128 postOpGas;
    address token;
    uint256 exchangeRate;
    bytes signature;
    uint128 paymasterValidationGasLimit;
    uint256 preFundInToken;
    uint128 constantFee;
    address recipient;
}

/// @title BaseSingletonPaymaster
/// @author Pimlico (vendored from github.com/pimlicolabs/singleton-paymaster/blob/master/src/base/BaseSingletonPaymaster.sol)
/// @notice Helper class for creating a singleton paymaster.
/// @dev Vendored with adaptations: EntryPoint v0.7 only (dropped v0.6 UserOperation overload), OZ 5.x SafeERC20
/// instead of solady SafeTransferLib, pragma lowered to ^0.8.24.
abstract contract BaseSingletonPaymaster is ManagerAccessControl, BasePaymaster, MultiSigner {
    // -------------------------------------------------------------
    // Custom errors
    // -------------------------------------------------------------

    error PaymasterAndDataLengthInvalid();
    error PaymasterModeInvalid();
    error PaymasterConfigLengthInvalid();
    error PaymasterSignatureLengthInvalid();
    error TokenAddressInvalid();
    error ExchangeRateInvalid();
    error RecipientInvalid();
    error PostOpTransferFromFailed(string msg);
    error PreFundTooHigh();

    // -------------------------------------------------------------
    // Events
    // -------------------------------------------------------------

    event UserOperationSponsored(
        bytes32 indexed userOpHash,
        address indexed user,
        uint8 paymasterMode,
        address token,
        uint256 tokenAmountPaid,
        uint256 exchangeRate
    );

    event BundlerAllowlistUpdated(address bundler, bool allowed);

    error BundlerNotAllowed(address bundler);

    // -------------------------------------------------------------
    // Constants / immutables
    // -------------------------------------------------------------

    uint8 immutable VERIFYING_MODE = 0;
    uint8 immutable ERC20_MODE = 1;
    uint8 immutable MODE_AND_ALLOW_ALL_BUNDLERS_LENGTH = 1;
    /// @notice Length of the fixed portion of the ERC-20 paymaster config (excluding optional fields + signature).
    uint8 immutable ERC20_PAYMASTER_DATA_LENGTH = 117;
    uint8 immutable VERIFYING_PAYMASTER_DATA_LENGTH = 12;

    // -------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------

    mapping(address bundler => bool allowed) public isBundlerAllowed;

    // -------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------

    constructor(
        address _entryPoint,
        address _owner,
        address _manager,
        address[] memory _signers
    ) BasePaymaster(_entryPoint, _owner, _manager) MultiSigner(_signers) {}

    // -------------------------------------------------------------
    // Admin functions
    // -------------------------------------------------------------

    function updateBundlerAllowlist(address[] calldata bundlers, bool allowed) external onlyAdminOrManager {
        for (uint256 i = 0; i < bundlers.length; i++) {
            isBundlerAllowed[bundlers[i]] = allowed;
            emit BundlerAllowlistUpdated(bundlers[i], allowed);
        }
    }

    // -------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------

    function _parsePaymasterAndData(
        bytes calldata _paymasterAndData,
        uint256 _paymasterDataOffset
    ) internal pure returns (uint8, bool, bytes calldata) {
        if (_paymasterAndData.length < _paymasterDataOffset + 1) {
            revert PaymasterAndDataLengthInvalid();
        }

        uint8 combinedByte = uint8(_paymasterAndData[_paymasterDataOffset]);
        bool allowAllBundlers = (combinedByte & 0x01) != 0;
        uint8 mode = uint8((combinedByte >> 1));

        bytes calldata paymasterConfig = _paymasterAndData[_paymasterDataOffset + 1:];

        return (mode, allowAllBundlers, paymasterConfig);
    }

    function _parseErc20Config(bytes calldata _paymasterConfig) internal pure returns (ERC20PaymasterData memory config) {
        if (_paymasterConfig.length < ERC20_PAYMASTER_DATA_LENGTH) {
            revert PaymasterConfigLengthInvalid();
        }

        uint128 configPointer = 0;

        uint8 combinedByte = uint8(_paymasterConfig[configPointer]);
        bool constantFeePresent = (combinedByte & 0x01) != 0;
        bool recipientPresent = (combinedByte & 0x02) != 0;
        bool preFundPresent = (combinedByte & 0x04) != 0;
        configPointer += 1;
        config.validUntil = uint48(bytes6(_paymasterConfig[configPointer:configPointer + 6]));
        configPointer += 6;
        config.validAfter = uint48(bytes6(_paymasterConfig[configPointer:configPointer + 6]));
        configPointer += 6;
        config.token = address(bytes20(_paymasterConfig[configPointer:configPointer + 20]));
        configPointer += 20;
        config.postOpGas = uint128(bytes16(_paymasterConfig[configPointer:configPointer + 16]));
        configPointer += 16;
        config.exchangeRate = uint256(bytes32(_paymasterConfig[configPointer:configPointer + 32]));
        configPointer += 32;
        config.paymasterValidationGasLimit = uint128(bytes16(_paymasterConfig[configPointer:configPointer + 16]));
        configPointer += 16;
        config.treasury = address(bytes20(_paymasterConfig[configPointer:configPointer + 20]));
        configPointer += 20;

        config.preFundInToken = uint256(0);
        if (preFundPresent) {
            if (_paymasterConfig.length < configPointer + 16) {
                revert PaymasterConfigLengthInvalid();
            }

            config.preFundInToken = uint128(bytes16(_paymasterConfig[configPointer:configPointer + 16]));
            configPointer += 16;
        }
        config.constantFee = uint128(0);
        if (constantFeePresent) {
            if (_paymasterConfig.length < configPointer + 16) {
                revert PaymasterConfigLengthInvalid();
            }

            config.constantFee = uint128(bytes16(_paymasterConfig[configPointer:configPointer + 16]));
            configPointer += 16;
        }

        config.recipient = address(0);
        if (recipientPresent) {
            if (_paymasterConfig.length < configPointer + 20) {
                revert PaymasterConfigLengthInvalid();
            }

            config.recipient = address(bytes20(_paymasterConfig[configPointer:configPointer + 20]));
            configPointer += 20;
        }
        config.signature = _paymasterConfig[configPointer:];

        if (config.token == address(0)) {
            revert TokenAddressInvalid();
        }

        if (config.exchangeRate == 0) {
            revert ExchangeRateInvalid();
        }

        if (recipientPresent && config.recipient == address(0)) {
            revert RecipientInvalid();
        }

        if (config.signature.length != 64 && config.signature.length != 65) {
            revert PaymasterSignatureLengthInvalid();
        }

        return config;
    }

    function _parseVerifyingConfig(bytes calldata _paymasterConfig) internal pure returns (uint48, uint48, bytes calldata) {
        if (_paymasterConfig.length < VERIFYING_PAYMASTER_DATA_LENGTH) {
            revert PaymasterConfigLengthInvalid();
        }

        uint48 validUntil = uint48(bytes6(_paymasterConfig[0:6]));
        uint48 validAfter = uint48(bytes6(_paymasterConfig[6:12]));
        bytes calldata signature = _paymasterConfig[12:];

        if (signature.length != 64 && signature.length != 65) {
            revert PaymasterSignatureLengthInvalid();
        }

        return (validUntil, validAfter, signature);
    }

    function _createPostOpContext(
        PackedUserOperation calldata _userOp,
        bytes32 _userOpHash,
        ERC20PaymasterData memory _cfg,
        uint256 _requiredPreFund
    ) internal pure returns (bytes memory) {
        uint256 executionGasLimit = _userOp.unpackCallGasLimit() + _userOp.unpackPostOpGasLimit();

        uint256 preOpGasApproximation = _userOp.preVerificationGas
            + _userOp.unpackVerificationGasLimit()
            + _cfg.paymasterValidationGasLimit;

        return abi.encode(
            ERC20PostOpContext({
                sender: _userOp.sender,
                token: _cfg.token,
                treasury: _cfg.treasury,
                exchangeRate: _cfg.exchangeRate,
                postOpGas: _cfg.postOpGas,
                userOpHash: _userOpHash,
                maxFeePerGas: uint256(0),
                maxPriorityFeePerGas: uint256(0),
                executionGasLimit: executionGasLimit,
                preFund: _requiredPreFund,
                preFundCharged: _cfg.preFundInToken,
                preOpGasApproximation: preOpGasApproximation,
                constantFee: _cfg.constantFee,
                recipient: _cfg.recipient
            })
        );
    }

    function _parsePostOpContext(bytes calldata _context) internal pure returns (ERC20PostOpContext memory ctx) {
        ctx = abi.decode(_context, (ERC20PostOpContext));
    }

    /// @notice Gets the cost in amount of tokens.
    /// @dev exchangeRate is "tokens per 1 ETH (1e18 wei)" in token base units.
    function getCostInToken(
        uint256 _actualGasCost,
        uint256 _postOpGas,
        uint256 _actualUserOpFeePerGas,
        uint256 _exchangeRate
    ) public pure returns (uint256) {
        return ((_actualGasCost + (_postOpGas * _actualUserOpFeePerGas)) * _exchangeRate) / 1e18;
    }
}
