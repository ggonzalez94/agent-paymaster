// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ManagerAccessControl} from "./ManagerAccessControl.sol";
import {IEntryPoint} from "account-abstraction/contracts/interfaces/IEntryPoint.sol";

/// @dev Vendored from pimlicolabs/singleton-paymaster. Named `BasePaymaster` to match upstream; lives under the
/// `pimlico` namespace to avoid conflict with account-abstraction's own BasePaymaster.
abstract contract BasePaymaster is ManagerAccessControl {
    IEntryPoint public immutable entryPoint;

    constructor(address _entryPoint, address _owner, address _manager) {
        entryPoint = IEntryPoint(_entryPoint);
        _grantRole(DEFAULT_ADMIN_ROLE, _owner);
        _grantRole(MANAGER_ROLE, _manager);
    }

    function deposit() public payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    function withdrawTo(address payable withdrawAddress, uint256 amount) public onlyRole(DEFAULT_ADMIN_ROLE) {
        entryPoint.withdrawTo(withdrawAddress, amount);
    }

    function addStake(uint32 unstakeDelaySec) external payable onlyAdminOrManager {
        entryPoint.addStake{value: msg.value}(unstakeDelaySec);
    }

    function getDeposit() public view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    function unlockStake() external onlyAdminOrManager {
        entryPoint.unlockStake();
    }

    function withdrawStake(address payable withdrawAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        entryPoint.withdrawStake(withdrawAddress);
    }

    function _requireFromEntryPoint() internal view virtual {
        require(msg.sender == address(entryPoint), "Sender not EntryPoint");
    }
}
