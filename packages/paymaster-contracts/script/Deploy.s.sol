// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ServoPaymaster} from "../src/ServoPaymaster.sol";

/// @notice Deploys ServoPaymaster (Pimlico SingletonPaymasterV7 + Servo treasury sweep) to the target chain.
/// @dev Required env vars: DEPLOYER_PRIVATE_KEY, ENTRYPOINT_ADDRESS, QUOTE_SIGNER_ADDRESS.
/// Optional: PAYMASTER_MANAGER_ADDRESS (defaults to deployer).
contract DeployServoPaymaster is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address entryPointAddr = vm.envAddress("ENTRYPOINT_ADDRESS");
        address quoteSigner = vm.envAddress("QUOTE_SIGNER_ADDRESS");
        address manager = vm.envOr("PAYMASTER_MANAGER_ADDRESS", deployer);

        address[] memory signers = new address[](1);
        signers[0] = quoteSigner;

        vm.startBroadcast(deployerPrivateKey);
        ServoPaymaster paymaster = new ServoPaymaster(entryPointAddr, deployer, manager, signers);
        vm.stopBroadcast();

        console.log("ServoPaymaster deployed");
        console.log("  deployer:", deployer);
        console.log("  contract:", address(paymaster));
        console.log("  entryPoint:", entryPointAddr);
        console.log("  admin(owner):", deployer);
        console.log("  manager:", manager);
        console.log("  signer:", quoteSigner);
    }
}
