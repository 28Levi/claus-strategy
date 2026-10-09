// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {StrategyTreasury} from "./StrategyTreasury.sol";
import {StrategyV4Hook} from "./StrategyV4Hook.sol";

/// @notice Atomically binds a strategy and permanently locks its initial full-range liquidity.
/// @dev Deploy one initializer per strategy. The authority has exactly one action: launch.
/// There is no LP removal, fee collection, approval, arbitrary call, or withdrawal function.
/// Rounding dust and the position's accrued LP fees are permanently inaccessible as well.
contract StrategyInitializer is IUnlockCallback {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;

    uint256 private constant Q96 = 1 << 96;
    uint256 public constant MIN_CONSUMPTION_BPS = 9_900;
    int24 public constant TICK_LOWER = -887220;
    int24 public constant TICK_UPPER = 887220;
    bytes32 public constant POSITION_SALT = bytes32(0);

    address public immutable launchAuthority;
    uint256 public immutable minNativeSeed;
    bool public initialized;
    address public treasury;
    StrategyV4Hook public hook;
    IPoolManager public poolManager;
    IERC20 public token;
    uint128 public lockedLiquidity;
    uint256 public nativeDeposited;
    uint256 public tokensDeposited;
    bool private _callbackPending;

    error Unauthorized();
    error AlreadyInitialized();
    error InvalidConfiguration();
    error InvalidSeed();
    error UnbalancedSeed();
    error UnexpectedCallback();
    error UnexpectedLiquidityDelta();

    event Initialized(
        address indexed treasury,
        address indexed hook,
        address indexed token,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        uint256 nativeDeposited,
        uint256 tokensDeposited
    );

    constructor(address launchAuthority_, uint256 minNativeSeed_) {
        if (launchAuthority_ == address(0) || minNativeSeed_ == 0
            || minNativeSeed_ > uint256(uint128(type(int128).max))) revert InvalidConfiguration();
        launchAuthority = launchAuthority_;
        minNativeSeed = minNativeSeed_;
    }

    /// @notice Launch using the whole token supply and at least the immutable native seed.
    /// @dev At least 99% of BOTH assets must enter the pool; the authority cannot choose
    /// a price that leaves a material allocation outside locked liquidity. All validation,
    /// treasury binding, pool initialization, and settlement revert together on failure.
    function initialize(address treasury_, address hook_, uint160 sqrtPriceX96) external payable {
        if (msg.sender != launchAuthority) revert Unauthorized();
        if (initialized) revert AlreadyInitialized();
        if (treasury_.code.length == 0 || hook_.code.length == 0) revert InvalidConfiguration();
        if (msg.value < minNativeSeed || msg.value > uint256(uint128(type(int128).max))) revert InvalidSeed();
        // Close the launch gate before any external interaction, including metadata reads.
        initialized = true;
        StrategyTreasury targetTreasury = StrategyTreasury(payable(treasury_));
        StrategyV4Hook targetHook = StrategyV4Hook(payable(hook_));
        IERC20 targetToken = IERC20(targetHook.token());
        IPoolManager manager = targetHook.poolManager();
        if (
            targetHook.poolInitializer() != address(this) || targetHook.treasury() != treasury_
                || targetTreasury.initializer() != address(this)
                || address(targetTreasury.token()) != address(targetToken)
                || address(targetTreasury.hook()) != address(0)
                || address(manager).code.length == 0 || address(targetToken).code.length == 0
        ) revert InvalidConfiguration();
        PoolKey memory key = targetHook.getPoolKey();
        if (
            Currency.unwrap(key.currency0) != address(0) || Currency.unwrap(key.currency1) != address(targetToken)
                || address(key.hooks) != hook_ || key.tickSpacing != 60 || key.fee != 0
        ) revert InvalidConfiguration();

        uint256 supply = targetToken.totalSupply();
        if (supply == 0 || supply > uint256(uint128(type(int128).max))
            || targetToken.balanceOf(address(this)) != supply) revert InvalidSeed();
        (uint128 liquidity, uint256 amount0, uint256 amount1) = _seedAmounts(sqrtPriceX96, msg.value, supply);
        treasury = treasury_;
        hook = targetHook;
        poolManager = manager;
        token = targetToken;
        lockedLiquidity = liquidity;
        nativeDeposited = amount0;
        tokensDeposited = amount1;

        targetTreasury.initializeHook(hook_);
        manager.initialize(key, sqrtPriceX96);
        _callbackPending = true;
        manager.unlock(bytes(""));
        if (_callbackPending) revert UnexpectedCallback();
        emit Initialized(treasury_, hook_, address(targetToken), sqrtPriceX96, liquidity, amount0, amount1);
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_callbackPending) revert UnexpectedCallback();
        _callbackPending = false;
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            hook.getPoolKey(),
            ModifyLiquidityParams({
                tickLower: TICK_LOWER,
                tickUpper: TICK_UPPER,
                liquidityDelta: int256(uint256(lockedLiquidity)),
                salt: POSITION_SALT
            }),
            bytes("")
        );
        // For a newly initialized position there can be no accrued fee credit. Verify
        // both actual debts match the rounded-up values used to check seed utilization.
        if (
            int256(delta.amount0()) != -int256(nativeDeposited)
                || int256(delta.amount1()) != -int256(tokensDeposited)
        ) revert UnexpectedLiquidityDelta();

        poolManager.sync(Currency.wrap(address(0)));
        poolManager.settle{value: nativeDeposited}();
        poolManager.sync(Currency.wrap(address(token)));
        token.safeTransfer(address(poolManager), tokensDeposited);
        poolManager.settle();
        return bytes("");
    }

    function _seedAmounts(uint160 sqrtPriceX96, uint256 nativeAmount, uint256 tokenAmount)
        private pure returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        uint160 lower = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint160 upper = TickMath.getSqrtPriceAtTick(TICK_UPPER);
        if (sqrtPriceX96 <= lower || sqrtPriceX96 >= upper) revert UnbalancedSeed();
        // Standard full-range liquidity calculation, rounded down. SqrtPriceMath
        // then computes the same rounded-up debts used by PoolManager.
        uint256 intermediate = Math.mulDiv(sqrtPriceX96, upper, Q96);
        uint256 liquidity0 = Math.mulDiv(nativeAmount, intermediate, upper - sqrtPriceX96);
        uint256 liquidity1 = Math.mulDiv(tokenAmount, Q96, sqrtPriceX96 - lower);
        uint256 available = Math.min(liquidity0, liquidity1);
        if (available == 0 || available > uint256(uint128(type(int128).max))) revert InvalidSeed();
        liquidity = uint128(available);
        amount0 = SqrtPriceMath.getAmount0Delta(sqrtPriceX96, upper, liquidity, true);
        amount1 = SqrtPriceMath.getAmount1Delta(lower, sqrtPriceX96, liquidity, true);
        if (
            amount0 > nativeAmount || amount1 > tokenAmount
                || amount0 < Math.mulDiv(nativeAmount, MIN_CONSUMPTION_BPS, 10_000, Math.Rounding.Ceil)
                || amount1 < Math.mulDiv(tokenAmount, MIN_CONSUMPTION_BPS, 10_000, Math.Rounding.Ceil)
        ) revert UnbalancedSeed();
    }
}
