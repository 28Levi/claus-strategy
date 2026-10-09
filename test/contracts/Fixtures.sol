// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {StrategyOracle} from "../../contracts/libraries/StrategyOracle.sol";

contract MockNFT is ERC721 {
    mapping(uint256 => uint256) public transferNonce;
    constructor() ERC721("Test collection", "NFT") {}
    function mint(address to, uint256 id) external { _mint(to, id); }
    function _update(address to, uint256 id, address auth) internal override returns (address from) {
        from = super._update(to, id, auth);
        transferNonce[id]++;
    }
}

interface ITreasuryFixture {
    function recordFees() external payable;
    function accountSurplus() external;
}

contract MockExecutor {
    address public immutable token;
    address public immutable treasury;
    uint256 public rate = 1000;
    uint256 public reportExtra;
    bool public fail;
    constructor(address token_, address treasury_) { token = token_; treasury = treasury_; }
    function fee() external payable { ITreasuryFixture(treasury).recordFees{value: msg.value}(); }
    function configure(uint256 rate_, uint256 extra_, bool fail_) external { rate = rate_; reportExtra = extra_; fail = fail_; }
    function executeBuyback() external payable returns (uint256 amount) {
        require(msg.sender == treasury && !fail, "Execution failed");
        ITreasuryFixture(treasury).accountSurplus();
        amount = msg.value * rate;
        require(IERC20(token).transfer(treasury, amount));
        return amount + reportExtra;
    }
}

contract Create2Deployer {
    function deploy(bytes32 salt, bytes memory code) external returns (address target) {
        assembly { target := create2(0, add(code, 0x20), mload(code), salt) }
        require(target != address(0), "CREATE2 failed");
    }
}

contract OracleHarness {
    using StrategyOracle for StrategyOracle.State;
    StrategyOracle.State private state;
    function write(int24 tick) external { state.write(tick); }
    function consult(uint32 period) external view returns (int24) { return state.consult(period); }
    function quote(int24 tick, uint256 amount) external pure returns (uint256) { return StrategyOracle.quoteToken1(tick, amount); }
}

contract ForceETH {
    constructor() payable {}
    function force(address payable recipient) external { selfdestruct(recipient); }
}
