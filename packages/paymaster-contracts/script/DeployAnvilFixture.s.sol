// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {EntryPoint} from "account-abstraction/contracts/core/EntryPoint.sol";
import {ServoPaymaster} from "../src/ServoPaymaster.sol";
import {ServoAccountFactory} from "../src/ServoAccountFactory.sol";
import {MockERC20Permit} from "../test/mocks/MockERC20Permit.sol";

/// @notice Deploys the full Servo stack onto Anvil for E2E testing.
contract DeployAnvilFixture is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address quoteSigner = vm.envAddress("QUOTE_SIGNER_ADDRESS");
        string memory outputPath = vm.envOr("FIXTURE_OUTPUT_PATH", string("/tmp/servo-anvil-fixture.json"));

        vm.startBroadcast(deployerPrivateKey);

        EntryPoint entryPoint = new EntryPoint();
        MockERC20Permit usdc = new MockERC20Permit();

        address[] memory signers = new address[](1);
        signers[0] = quoteSigner;

        ServoPaymaster paymaster = new ServoPaymaster(address(entryPoint), deployer, deployer, signers);
        ServoAccountFactory factory = new ServoAccountFactory(entryPoint);

        // Fund the paymaster's EntryPoint deposit.
        entryPoint.depositTo{value: 2 ether}(address(paymaster));

        vm.stopBroadcast();

        string memory json = string.concat(
            '{"entryPoint":"', vm.toString(address(entryPoint)),
            '","usdc":"', vm.toString(address(usdc)),
            '","paymaster":"', vm.toString(address(paymaster)),
            '","factory":"', vm.toString(address(factory)),
            '","quoteSigner":"', vm.toString(quoteSigner),
            '"}'
        );
        vm.writeFile(outputPath, json);

        console.log("Anvil fixture deployed");
        console.log("  entryPoint:", address(entryPoint));
        console.log("  usdc:", address(usdc));
        console.log("  paymaster:", address(paymaster));
        console.log("  factory:", address(factory));
        console.log("  quoteSigner:", quoteSigner);
        console.log("  output:", outputPath);
    }
}
