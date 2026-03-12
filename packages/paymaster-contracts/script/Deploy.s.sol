// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {TaikoUsdcPaymaster} from "../src/TaikoUsdcPaymaster.sol";

contract DeployTaikoUsdcPaymaster is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address entryPointAddr = vm.envAddress("ENTRYPOINT_ADDRESS");
        address usdcAddress = vm.envAddress("USDC_ADDRESS");
        address quoteSigner = vm.envAddress("QUOTE_SIGNER_ADDRESS");
        address priceOracle = vm.envAddress("USDC_PRICE_ORACLE_ADDRESS");
        uint256 surchargeBps = vm.envUint("PAYMASTER_SURCHARGE_BPS");
        uint256 maxVerificationGasLimit = vm.envUint("PAYMASTER_MAX_VERIFICATION_GAS_LIMIT");
        uint256 postOpOverheadGas = vm.envUint("PAYMASTER_POSTOP_OVERHEAD_GAS");
        uint256 maxNativeCostWei = vm.envUint("PAYMASTER_MAX_NATIVE_COST_WEI");
        uint256 maxQuoteTtlSeconds = vm.envUint("PAYMASTER_QUOTE_TTL_SECONDS");

        vm.startBroadcast(deployerPrivateKey);

        TaikoUsdcPaymaster paymaster = new TaikoUsdcPaymaster(
            IEntryPoint(entryPointAddr),
            usdcAddress,
            quoteSigner,
            priceOracle,
            surchargeBps,
            maxVerificationGasLimit,
            postOpOverheadGas,
            maxNativeCostWei,
            maxQuoteTtlSeconds
        );

        vm.stopBroadcast();

        console.log("TaikoUsdcPaymaster deployed");
        console.log("  deployer:", deployer);
        console.log("  contract:", address(paymaster));
        console.log("  entryPoint:", entryPointAddr);
        console.log("  usdc:", usdcAddress);
        console.log("  quoteSigner:", quoteSigner);
        console.log("  priceOracle:", priceOracle);
    }
}
