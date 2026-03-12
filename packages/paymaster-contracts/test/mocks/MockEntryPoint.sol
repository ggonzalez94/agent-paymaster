// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEntryPoint} from "account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {IPaymaster} from "account-abstraction/contracts/interfaces/IPaymaster.sol";
import {PackedUserOperation} from "account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

contract MockEntryPoint is IEntryPoint, IERC165 {
    mapping(address => uint256) public deposits;
    mapping(address => uint256) public stakes;
    mapping(address => uint32) public unstakeDelayMap;

    // IERC165

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IEntryPoint).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // IStakeManager

    function getDepositInfo(address account) external view override returns (DepositInfo memory) {
        return DepositInfo({
            deposit: deposits[account],
            staked: stakes[account] > 0,
            stake: uint112(stakes[account]),
            unstakeDelaySec: unstakeDelayMap[account],
            withdrawTime: 0
        });
    }

    function balanceOf(address account) external view override returns (uint256) {
        return deposits[account];
    }

    function depositTo(address account) external payable override {
        deposits[account] += msg.value;
    }

    function addStake(uint32 unstakeDelaySec) external payable override {
        stakes[msg.sender] += msg.value;
        unstakeDelayMap[msg.sender] = unstakeDelaySec;
    }

    function unlockStake() external override {}

    function withdrawStake(address payable withdrawAddress) external override {
        uint256 stake = stakes[msg.sender];
        stakes[msg.sender] = 0;
        (bool success,) = withdrawAddress.call{value: stake}("");
        require(success, "STAKE_WITHDRAW_FAILED");
    }

    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external override {
        uint256 dep = deposits[msg.sender];
        require(dep >= withdrawAmount, "INSUFFICIENT_DEPOSIT");
        deposits[msg.sender] = dep - withdrawAmount;
        (bool success,) = withdrawAddress.call{value: withdrawAmount}("");
        require(success, "WITHDRAW_FAILED");
    }

    // INonceManager

    function getNonce(address, uint192) external pure override returns (uint256) {
        return 0;
    }

    function incrementNonce(uint192) external override {}

    // IEntryPoint

    function handleOps(PackedUserOperation[] calldata, address payable) external override {}

    function handleAggregatedOps(UserOpsPerAggregator[] calldata, address payable) external override {}

    function getUserOpHash(PackedUserOperation calldata) external pure override returns (bytes32) {
        return bytes32(0);
    }

    function getSenderAddress(bytes memory) external pure override {
        revert SenderAddressResult(address(0));
    }

    function delegateAndRevert(address, bytes calldata) external pure override {
        revert DelegateAndRevert(false, "");
    }

    // Test helpers

    function callValidatePaymaster(
        IPaymaster paymaster,
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) external returns (bytes memory context, uint256 validationData) {
        return paymaster.validatePaymasterUserOp(userOp, userOpHash, maxCost);
    }

    function callPostOp(
        IPaymaster paymaster,
        IPaymaster.PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    ) external {
        paymaster.postOp(mode, context, actualGasCost, actualUserOpFeePerGas);
    }
}
