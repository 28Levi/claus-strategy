// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @notice Fixed supply. No owner, mint, tax setter, blacklist or upgrade mechanism.
contract StrategyToken is ERC20, ERC20Burnable {
    constructor(string memory name_, string memory symbol_, uint256 supply_, address initializer_)
        ERC20(name_, symbol_)
    {
        require(initializer_ != address(0) && supply_ != 0, "Invalid allocation");
        _mint(initializer_, supply_);
    }
}
