// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Official Seaport/Conduit implementations are compiled separately by
// scripts/compile-seaport.mjs with their own compiler and optimizer settings.
import {ZoneParameters} from "seaport-types/src/lib/ConsiderationStructs.sol";

contract TestSeaportZone {
    address public immutable seaport;
    address public expectedFulfiller;
    constructor(address seaport_) { seaport = seaport_; }
    function setExpectedFulfiller(address fulfiller) external { expectedFulfiller = fulfiller; }
    function authorizeOrder(ZoneParameters calldata p) external view returns (bytes4) {
        require(msg.sender == seaport && keccak256(p.extraData) == keccak256(hex"1234"), "Invalid zone data");
        require(p.fulfiller == expectedFulfiller, "Wrong fulfiller");
        return this.authorizeOrder.selector;
    }
    function validateOrder(ZoneParameters calldata p) external view returns (bytes4) {
        require(msg.sender == seaport && keccak256(p.extraData) == keccak256(hex"1234"), "Invalid zone data");
        require(p.fulfiller == expectedFulfiller, "Wrong fulfiller");
        return this.validateOrder.selector;
    }
}

contract NoPurchaseTarget {
    function purchaseCheapest(uint256, uint256) external {}
}

contract RejectSeaportPayment {
    receive() external payable { revert("Reject payment"); }
}
