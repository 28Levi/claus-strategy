// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @notice A timestamp-indexed cumulative tick oracle for one pool.
/// @dev At most one observation per second. The 4096 slots retain more than the
/// maximum 3600-second consultation window, even on chains with one-second blocks.
/// Pool prices are endogenous: this does not establish an independent fair value.
library StrategyOracle {
    uint16 internal constant CAPACITY = 4096;

    struct Observation {
        uint64 timestamp;
        int128 tickCumulative;
        int24 tickAfter;
    }

    struct State {
        Observation[4096] observations;
        uint16 newest;
        uint16 count;
    }

    error InsufficientHistory();
    error InvalidOracleWindow();
    error InvalidOracleTick();

    function write(State storage self, int24 tick) internal {
        if (tick < TickMath.MIN_TICK || tick > TickMath.MAX_TICK) revert InvalidOracleTick();
        uint64 timestamp = uint64(block.timestamp);
        if (self.count == 0) {
            self.observations[0] = Observation(timestamp, 0, tick);
            self.count = 1;
            return;
        }
        Observation memory last = self.observations[self.newest];
        if (timestamp == last.timestamp) {
            // Only the final tick in a timestamp contributes to subsequent time.
            self.observations[self.newest].tickAfter = tick;
            return;
        }
        uint16 next = uint16((uint256(self.newest) + 1) % CAPACITY);
        self.observations[next] = Observation(timestamp, cumulativeAt(last, timestamp), tick);
        self.newest = next;
        if (self.count < CAPACITY) ++self.count;
    }

    function consult(State storage self, uint32 window) internal view returns (int24 averageTick) {
        if (window < 1800 || window > 3600) revert InvalidOracleWindow();
        if (self.count == 0 || block.timestamp < window) revert InsufficientHistory();
        uint64 nowTimestamp = uint64(block.timestamp);
        uint64 target = nowTimestamp - window;
        uint256 oldest = (uint256(self.newest) + CAPACITY + 1 - self.count) % CAPACITY;
        if (self.observations[oldest].timestamp > target) revert InsufficientHistory();

        // Find the last observation at or before the target, in logical ring order.
        uint256 low;
        uint256 high = self.count;
        while (low + 1 < high) {
            uint256 middle = (low + high) / 2;
            if (self.observations[(oldest + middle) % CAPACITY].timestamp <= target) low = middle;
            else high = middle;
        }
        Observation memory beforeTarget = self.observations[(oldest + low) % CAPACITY];
        int128 difference = cumulativeAt(self.observations[self.newest], nowTimestamp)
            - cumulativeAt(beforeTarget, target);
        int128 period = int128(uint128(window));
        int128 mean = difference / period;
        // Solidity truncates toward zero; tick arithmetic must round toward -infinity.
        if (difference < 0 && difference % period != 0) --mean;
        averageTick = int24(mean);
    }

    function quoteToken1(int24 tick, uint256 amount0) internal pure returns (uint256) {
        uint160 sqrtRatioX96 = TickMath.getSqrtPriceAtTick(tick);
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            return Math.mulDiv(ratioX192, amount0, uint256(1) << 192);
        }
        uint256 ratioX128 = Math.mulDiv(sqrtRatioX96, sqrtRatioX96, uint256(1) << 64);
        return Math.mulDiv(ratioX128, amount0, uint256(1) << 128);
    }

    function cumulativeAt(Observation memory observation, uint64 timestamp) private pure returns (int128) {
        return observation.tickCumulative
            + int128(observation.tickAfter) * int128(uint128(timestamp - observation.timestamp));
    }
}
