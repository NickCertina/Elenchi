// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ElenchiArena} from "../src/ElenchiArena.sol";

interface VmDeploy {
    function envUint(string calldata key) external returns (uint256);
    function envAddress(string calldata key) external returns (address);
    function envOr(string calldata key, uint256 defaultValue) external returns (uint256);
    function envOr(string calldata key, address defaultValue) external returns (address);
    function startBroadcast(uint256 deployerPrivateKey) external;
    function stopBroadcast() external;
}

/**
 * @title DeployElenchiArena
 * @notice Foundry deployment script for Robinhood Chain Testnet (46630) and Mainnet (4663).
 *         NOTE: Never deploys an ERC-20 token. $ELENCHI is launched manually on Pons by the owner.
 */
contract DeployElenchiArena {
    VmDeploy internal constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (ElenchiArena deployed) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address initialOwner = vm.envAddress("ARENA_OWNER_ADDRESS");
        address initialAttestor = vm.envAddress("ARENA_ATTESTOR_ADDRESS");
        address feeRecipient = vm.envOr("ARENA_FEE_RECIPIENT", initialOwner);
        uint256 initialFeeWei = vm.envOr("ARENA_FEE_WEI", uint256(0));
        address optionalToken = vm.envOr("ELENCHI_TOKEN_ADDRESS", address(0));

        vm.startBroadcast(deployerKey);
        deployed = new ElenchiArena(
            initialOwner,
            initialAttestor,
            feeRecipient,
            initialFeeWei,
            optionalToken
        );
        vm.stopBroadcast();
    }
}
