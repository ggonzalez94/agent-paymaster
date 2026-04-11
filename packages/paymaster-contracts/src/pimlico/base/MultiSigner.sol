// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ManagerAccessControl} from "./ManagerAccessControl.sol";

abstract contract MultiSigner is ManagerAccessControl {
    event SignerAdded(address signer);
    event SignerRemoved(address signer);

    mapping(address account => bool isValidSigner) public signers;

    constructor(address[] memory _initialSigners) {
        for (uint256 i = 0; i < _initialSigners.length; i++) {
            signers[_initialSigners[i]] = true;
        }
    }

    function removeSigner(address _signer) public onlyAdminOrManager {
        signers[_signer] = false;
        emit SignerRemoved(_signer);
    }

    function addSigner(address _signer) public onlyAdminOrManager {
        signers[_signer] = true;
        emit SignerAdded(_signer);
    }
}
