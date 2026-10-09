// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @dev Read-only integration assertions against the actual v4 PoolManager storage.
contract InitializerPositionReader {
    using StateLibrary for IPoolManager;

    function positionLiquidity(IPoolManager manager, PoolId poolId, address owner) external view returns (uint128) {
        (uint128 liquidity,,) = manager.getPositionInfo(poolId, owner, -887220, 887220, bytes32(0));
        return liquidity;
    }

    function tokenOnlyPositionLiquidity(IPoolManager manager, PoolId poolId, address owner) external view returns (uint128) {
        (uint128 liquidity,,) = manager.getPositionInfo(poolId, owner, -887220, 175020, bytes32(0));
        return liquidity;
    }
}
