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

/// @notice One-time launch that permanently locks the full token allocation in a one-sided position.
/// @dev At the fixed upper tick, the position initially contains token1 only. Buys supply
/// its native liquidity. The required 2 wei stays locked here, not in pool reserves.
/// The fixed tick implies ~25 ETH initial FDV for a 1 billion / 18-decimal token supply;
/// a different supply changes that valuation. No withdrawals, LP removal, or fee collection.
contract StrategyTokenOnlyInitializer is IUnlockCallback {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;

    uint256 private constant Q96 = 1 << 96;
    uint256 public constant NATIVE_SEED = 2;
    uint256 public constant MIN_CONSUMPTION_BPS = 9_900;
    int24 public constant TICK_LOWER = -887220;
    int24 public constant TICK_UPPER = 175020;
    bytes32 public constant POSITION_SALT = bytes32(0);

    address public immutable launchAuthority;
    bool public initialized;
    address public treasury;
    StrategyV4Hook public hook;
    IPoolManager public poolManager;
    IERC20 public token;
    uint128 public lockedLiquidity;
    uint256 public tokensDeposited;
    uint256 public constant nativeDeposited = 0;
    bool private _callbackPending;

    error Unauthorized();
    error AlreadyInitialized();
    error InvalidConfiguration();
    error InvalidSeed();
    error InvalidInitialPrice();
    error UnexpectedCallback();
    error UnexpectedLiquidityDelta();

    event Initialized(
        address indexed treasury,
        address indexed hook,
        address indexed token,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        uint256 tokensDeposited
    );

    constructor(address launchAuthority_) {
        if (launchAuthority_ == address(0)) revert InvalidConfiguration();
        launchAuthority = launchAuthority_;
    }

    function initialSqrtPriceX96() public pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(TICK_UPPER);
    }

    function initialize(address treasury_, address hook_, uint160 sqrtPriceX96) external payable {
        if (msg.sender != launchAuthority) revert Unauthorized();
        if (initialized) revert AlreadyInitialized();
        if (msg.value != NATIVE_SEED) revert InvalidSeed();
        if (sqrtPriceX96 != initialSqrtPriceX96()) revert InvalidInitialPrice();
        if (treasury_.code.length == 0 || hook_.code.length == 0) revert InvalidConfiguration();
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
        uint160 lower = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint256 liquidity = Math.mulDiv(supply, Q96, sqrtPriceX96 - lower);
        if (liquidity == 0 || liquidity > uint256(uint128(type(int128).max))) revert InvalidSeed();
        uint256 amount1 = SqrtPriceMath.getAmount1Delta(lower, sqrtPriceX96, uint128(liquidity), true);
        if (amount1 > supply || amount1 < Math.mulDiv(supply, MIN_CONSUMPTION_BPS, 10_000, Math.Rounding.Ceil)) {
            revert InvalidSeed();
        }
        treasury = treasury_;
        hook = targetHook;
        poolManager = manager;
        token = targetToken;
        lockedLiquidity = uint128(liquidity);
        tokensDeposited = amount1;

        targetTreasury.initializeHook(hook_);
        manager.initialize(key, sqrtPriceX96);
        _callbackPending = true;
        manager.unlock(bytes(""));
        if (_callbackPending) revert UnexpectedCallback();
        emit Initialized(treasury_, hook_, address(targetToken), sqrtPriceX96, uint128(liquidity), amount1);
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
        if (delta.amount0() != 0 || int256(delta.amount1()) != -int256(tokensDeposited)) {
            revert UnexpectedLiquidityDelta();
        }
        poolManager.sync(Currency.wrap(address(token)));
        token.safeTransfer(address(poolManager), tokensDeposited);
        poolManager.settle();
        return bytes("");
    }
}
