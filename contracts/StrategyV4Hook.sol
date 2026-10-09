// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {IStrategyBuyback} from "./interfaces/IStrategyBuyback.sol";
import {StrategyOracle} from "./libraries/StrategyOracle.sol";

interface IStrategyFeeReceiver {
    function recordFees() external payable;
}

/// @notice Immutable, single-pool ETH trading fees and treasury-only TWAP-bounded buybacks.
/// @dev Requires a CREATE2 address whose low 14 bits equal 0x30cc. No owner,
/// setters, arbitrary call targets, token approvals, or asset withdrawal functions.
/// User routes must use exact input. Buys must consume their full input after tax.
contract StrategyV4Hook is IHooks, IUnlockCallback, IStrategyBuyback {
    using PoolIdLibrary for PoolKey;
    using BalanceDeltaLibrary for BalanceDelta;
    using StateLibrary for IPoolManager;
    using StrategyOracle for StrategyOracle.State;

    uint24 public constant POOL_FEE = 0;
    int24 public constant TICK_SPACING = 60;
    uint160 public constant REQUIRED_HOOK_FLAGS = 0x30cc;
    uint256 private constant BPS = 10_000;

    IPoolManager public immutable poolManager;
    address public immutable token;
    address public immutable treasury;
    address public immutable poolInitializer;
    uint16 public immutable feeBps;
    uint32 public immutable twapWindow;
    uint16 public immutable maxSlippageBps;

    StrategyOracle.State private _oracle;
    // 0 = idle, 1 = buyback, 2 = realize fee claims after the trader has settled.
    uint8 private _operation;
    uint256 public pendingFees;

    error InvalidConfiguration();
    error OnlyPoolManager();
    error OnlyTreasury();
    error OnlyInitializer();
    error WrongPool();
    error ExactInputOnly();
    error InvalidAmount();
    error PartialFill();
    error SlippageExceeded(uint256 received, uint256 minimum);
    error UnexpectedCallback();
    error HookNotEnabled();

    event TradingFeeCollected(bool indexed buy, uint256 amount);
    event FeesFlushed(uint256 amount);
    event BuybackExecuted(uint256 ethSpent, uint256 tokensReceived, uint256 minimumOut);

    constructor(
        IPoolManager manager,
        address token_,
        address treasury_,
        address poolInitializer_,
        uint16 feeBps_,
        uint32 twapWindow_,
        uint16 maxSlippageBps_
    ) {
        if (
            address(manager).code.length == 0 || token_ == address(0) || treasury_ == address(0)
                || poolInitializer_ == address(0) || feeBps_ == 0 || feeBps_ > 1000
                || twapWindow_ < 1800 || twapWindow_ > 3600 || maxSlippageBps_ > 1000
        ) revert InvalidConfiguration();
        poolManager = manager;
        token = token_;
        treasury = treasury_;
        poolInitializer = poolInitializer_;
        feeBps = feeBps_;
        twapWindow = twapWindow_;
        maxSlippageBps = maxSlippageBps_;
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    modifier onlyManager() {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        _;
    }

    receive() external payable onlyManager {}

    function getHookPermissions() public pure returns (Hooks.Permissions memory permissions) {
        permissions.beforeInitialize = true;
        permissions.afterInitialize = true;
        permissions.beforeSwap = true;
        permissions.afterSwap = true;
        permissions.beforeSwapReturnDelta = true;
        permissions.afterSwapReturnDelta = true;
    }

    function getPoolKey() public view returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(token), POOL_FEE, TICK_SPACING, IHooks(address(this)));
    }

    /// @notice Derived from immutable configuration, including this hook's CREATE2 address.
    function poolId() public view returns (PoolId) {
        return getPoolKey().toId();
    }

    function beforeInitialize(address sender, PoolKey calldata key, uint160)
        external view onlyManager returns (bytes4)
    {
        _checkPool(key);
        if (sender != poolInitializer) revert OnlyInitializer();
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata key, uint160, int24 tick)
        external onlyManager returns (bytes4)
    {
        _checkPool(key);
        _oracle.write(tick);
        return IHooks.afterInitialize.selector;
    }

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external onlyManager returns (bytes4, BeforeSwapDelta, uint24)
    {
        _checkPool(key);
        uint256 amount = _exactInputAmount(params.amountSpecified);
        uint256 fee;
        if (params.zeroForOne && sender != address(this)) {
            fee = Math.mulDiv(amount, feeBps, BPS);
            _accrueFee(fee, true);
        }
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(uint128(fee)), 0), 0);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyManager returns (bytes4, int128) {
        _checkPool(key);
        uint256 amount = _exactInputAmount(params.amountSpecified);
        _recordCurrentTick();
        uint256 fee;
        if (sender != address(this)) {
            if (params.zeroForOne) {
                // Charging specified ETH before the swap is safe only when all of
                // the remaining input is used. Partial fills revert atomically.
                uint256 expected = amount - Math.mulDiv(amount, feeBps, BPS);
                if (delta.amount0() >= 0 || uint256(-int256(delta.amount0())) != expected) revert PartialFill();
            } else if (delta.amount0() > 0) {
                fee = Math.mulDiv(uint128(delta.amount0()), feeBps, BPS);
                _accrueFee(fee, false);
            }
        }
        return (IHooks.afterSwap.selector, int128(uint128(fee)));
    }

    /// @notice The minimum output is fixed by this pool's historical ticks, not a keeper quote.
    /// @dev Includes the static LP fee and immutable slippage allowance. A future
    /// PoolManager protocol fee can make execution more restrictive, never less.
    function minimumBuybackOut(uint256 amountIn) public view returns (uint256 amountOut) {
        if (amountIn == 0 || amountIn > uint256(uint128(type(int128).max))) revert InvalidAmount();
        int24 meanTick = _oracle.consult(twapWindow);
        uint256 afterPoolFee = Math.mulDiv(amountIn, 1_000_000 - POOL_FEE, 1_000_000);
        uint256 quote = StrategyOracle.quoteToken1(meanTick, afterPoolFee);
        amountOut = Math.mulDiv(quote, BPS - maxSlippageBps, BPS);
        if (amountOut == 0) revert InvalidAmount();
    }

    function consultTick() external view returns (int24) {
        return _oracle.consult(twapWindow);
    }

    function oracleState() external view returns (uint16 newest, uint16 count) {
        return (_oracle.newest, _oracle.count);
    }

    function executeBuyback() external payable returns (uint256 amountOut) {
        if (msg.sender != treasury) revert OnlyTreasury();
        if (_operation != 0) revert UnexpectedCallback();
        uint256 minimum = minimumBuybackOut(msg.value);
        _operation = 1;
        amountOut = abi.decode(poolManager.unlock(abi.encode(msg.value, minimum)), (uint256));
        _operation = 0;
        emit BuybackExecuted(msg.value, amountOut, minimum);
    }

    function unlockCallback(bytes calldata data) external onlyManager returns (bytes memory) {
        if (_operation == 2) {
            uint256 amount = abi.decode(data, (uint256));
            poolManager.burn(address(this), 0, amount);
            poolManager.take(Currency.wrap(address(0)), address(this), amount);
            IStrategyFeeReceiver(treasury).recordFees{value: amount}();
            return bytes("");
        }
        if (_operation != 1) revert UnexpectedCallback();
        (uint256 amountIn, uint256 minimum) = abi.decode(data, (uint256, uint256));
        BalanceDelta delta = poolManager.swap(
            getPoolKey(),
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            bytes("")
        );
        if (delta.amount0() >= 0 || uint256(-int256(delta.amount0())) != amountIn) revert PartialFill();
        if (delta.amount1() <= 0) revert SlippageExceeded(0, minimum);
        uint256 amountOut = uint128(delta.amount1());
        if (amountOut < minimum) revert SlippageExceeded(amountOut, minimum);

        // v4 deliberately skips callbacks when the hook is the swap sender.
        _recordCurrentTick();
        poolManager.sync(Currency.wrap(address(0)));
        poolManager.settle{value: amountIn}();
        poolManager.take(Currency.wrap(token), treasury, amountOut);
        return abi.encode(amountOut);
    }

    /// @notice Anyone may realize accrued native claims; ETH can only reach the treasury.
    /// @dev This must run after the trade unlock completes, not inside its callbacks.
    function flushFees() external {
        if (_operation != 0) revert UnexpectedCallback();
        uint256 amount = pendingFees;
        if (amount == 0) return;
        pendingFees = 0;
        _operation = 2;
        poolManager.unlock(abi.encode(amount));
        _operation = 0;
        emit FeesFlushed(amount);
    }

    function _accrueFee(uint256 fee, bool buy) private {
        if (fee == 0) return;
        // Taking ETH now would rely on unrelated pool balances on the first trade.
        // Claims balance our hook delta without requiring the input to be settled yet.
        poolManager.mint(address(this), 0, fee);
        pendingFees += fee;
        emit TradingFeeCollected(buy, fee);
    }

    function _recordCurrentTick() private {
        (, int24 tick,,) = poolManager.getSlot0(poolId());
        _oracle.write(tick);
    }

    function _checkPool(PoolKey calldata key) private view {
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(poolId())) revert WrongPool();
    }

    function _exactInputAmount(int256 specified) private pure returns (uint256 amount) {
        if (specified >= 0) revert ExactInputOnly();
        if (specified < -int256(type(int128).max)) revert InvalidAmount();
        amount = uint256(-specified);
    }

    // Disabled hooks deliberately fail closed if called outside their declared mask.
    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external pure returns (bytes4) { revert HookNotEnabled(); }
    function afterAddLiquidity(
        address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata
    ) external pure returns (bytes4, BalanceDelta) { revert HookNotEnabled(); }
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external pure returns (bytes4) { revert HookNotEnabled(); }
    function afterRemoveLiquidity(
        address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata
    ) external pure returns (bytes4, BalanceDelta) { revert HookNotEnabled(); }
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external pure returns (bytes4) { revert HookNotEnabled(); }
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external pure returns (bytes4) { revert HookNotEnabled(); }
}
